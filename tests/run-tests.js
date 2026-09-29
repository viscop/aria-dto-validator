var fs = require("fs");
var path = require("path");

var rootDir = path.resolve(__dirname, "..");
var casesDir = path.join(__dirname, "cases");
var validatorPath = resolveValidatorPath();
var validatorScript = fs.readFileSync(validatorPath, "utf8");

var systemShim = {
    getDateFromFormat: function (value) {
        return new Date(value);
    },
    log: function () {},
    warn: function () {},
    error: function () {}
};

/**
 * Resolves the validator source file used by the test runner.
 *
 * The repository may contain the Action body either as `validateDto.js` for
 * editor tooling or as `validateDto` to mirror the vRO Action name. Supporting
 * both keeps the tests independent from the chosen file naming convention.
 *
 * @returns {string} Absolute path to the validator source file.
 * @throws {Error} If no supported validator source file is found.
 */
function resolveValidatorPath() {
    var candidates = [
        path.join(rootDir, "validateDto.js"),
        path.join(rootDir, "validateDto")
    ];

    for (var i = 0; i < candidates.length; i++) {
        if (fs.existsSync(candidates[i])) {
            return candidates[i];
        }
    }

    throw new Error("Could not find validator source file. Expected validateDto.js or validateDto.");
}

/**
 * Creates a JSON-safe deep clone.
 *
 * Cloning keeps test case data isolated between executions and mirrors the
 * plain JSON nature of the test fixtures.
 *
 * @param {*} value Value to clone.
 * @returns {*} Cloned value.
 */
function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

/**
 * Loads and parses a JSON file.
 *
 * @param {string} filePath Absolute path to the JSON file.
 * @returns {*} Parsed JSON content.
 */
function loadJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/**
 * Creates an executable wrapper around the vRO-style validator script.
 *
 * The production `validateDto` file starts with `return result;`, which matches
 * an Aria/vRO Action body but is not a CommonJS module. `new Function(...)`
 * lets the test runner execute it with the same input variables that vRO would
 * provide: `policy`, `userDTO`, `backendDTO`, and `System`.
 *
 * @returns {Function} Function accepting (policy, userDTO, backendDTO, System).
 */
function createValidatorAction() {
    return new Function("policy", "userDTO", "backendDTO", "System", validatorScript);
}

/**
 * Resolves the policy from a test case.
 *
 * Test cases may provide either `policy` as a parsed JSON-compatible array or
 * `policyJson` as a string. `policyJson` mirrors policies stored in Aria
 * Configuration Elements, where the workflow parses JSON before validation.
 *
 * @param {Object} testCase Loaded test case.
 * @returns {Array<Object>} Policy rule array.
 */
function resolvePolicy(testCase) {
    if (testCase.policyJson) {
        return JSON.parse(testCase.policyJson);
    }
    return testCase.policy;
}

/**
 * Checks whether every expected fragment appears in the actual message list.
 *
 * Matching by fragment keeps tests stable when the validator returns contextual
 * technical details around the expected error or warning.
 *
 * @param {Array<string>} actualList Actual error or warning messages.
 * @param {Array<string>} expectedFragments Expected message fragments.
 * @returns {Array<string>} Expected fragments that were not found.
 */
function containsAll(actualList, expectedFragments) {
    var missing = [];
    var actualText = (actualList || []).join("\n");

    for (var i = 0; i < expectedFragments.length; i++) {
        if (actualText.indexOf(expectedFragments[i]) === -1) {
            missing.push(expectedFragments[i]);
        }
    }

    return missing;
}

/**
 * Finds fragments that unexpectedly appear in the actual message list.
 *
 * @param {Array<string>} actualList Actual error or warning messages.
 * @param {Array<string>} forbiddenFragments Fragments that must not appear.
 * @returns {Array<string>} Forbidden fragments that were found.
 */
function containsAny(actualList, forbiddenFragments) {
    var found = [];
    var actualText = (actualList || []).join("\n");

    for (var i = 0; i < forbiddenFragments.length; i++) {
        if (actualText.indexOf(forbiddenFragments[i]) !== -1) {
            found.push(forbiddenFragments[i]);
        }
    }

    return found;
}

/**
 * Executes a single JSON test case.
 *
 * @param {string} fileName Test case file name relative to tests/cases.
 * @returns {{name:string,fileName:string,result:Object,failures:Array<string>}}
 */
function runCase(fileName) {
    var testCase = loadJson(path.join(casesDir, fileName));
    var action = createValidatorAction();
    var policy = resolvePolicy(testCase);
    var result = action(
        cloneJson(policy || []),
        cloneJson(testCase.userDTO || {}),
        cloneJson(testCase.backendDTO || {}),
        systemShim
    );

    var expected = testCase.expected || {};
    var failures = [];

    if (typeof expected.valid === "boolean" && result.valid !== expected.valid) {
        failures.push("expected valid=" + expected.valid + " but got valid=" + result.valid);
    }

    if (expected.errorIncludes) {
        var missingErrors = containsAll(result.errors, expected.errorIncludes);
        for (var e = 0; e < missingErrors.length; e++) {
            failures.push("missing expected error fragment: " + missingErrors[e]);
        }
    }

    if (expected.errorExcludes) {
        var unexpectedErrors = containsAny(result.errors, expected.errorExcludes);
        for (var ue = 0; ue < unexpectedErrors.length; ue++) {
            failures.push("unexpected error fragment: " + unexpectedErrors[ue]);
        }
    }

    if (typeof expected.errorCount === "number" && result.errors.length !== expected.errorCount) {
        failures.push("expected errorCount=" + expected.errorCount + " but got errorCount=" + result.errors.length);
    }

    if (expected.warningIncludes) {
        var missingWarnings = containsAll(result.warnings, expected.warningIncludes);
        for (var w = 0; w < missingWarnings.length; w++) {
            failures.push("missing expected warning fragment: " + missingWarnings[w]);
        }
    }

    if (expected.warningExcludes) {
        var unexpectedWarnings = containsAny(result.warnings, expected.warningExcludes);
        for (var uw = 0; uw < unexpectedWarnings.length; uw++) {
            failures.push("unexpected warning fragment: " + unexpectedWarnings[uw]);
        }
    }

    if (typeof expected.warningCount === "number" && result.warnings.length !== expected.warningCount) {
        failures.push("expected warningCount=" + expected.warningCount + " but got warningCount=" + result.warnings.length);
    }

    return {
        name: testCase.name || fileName,
        fileName: fileName,
        result: result,
        failures: failures
    };
}

/**
 * Executes one JavaScript-only context-code test.
 *
 * Function-based messages cannot be represented by the JSON fixtures, so these
 * cases verify the ctx.code API directly with native JavaScript policies.
 *
 * @param {string} name Test name.
 * @param {Array<Object>} policy Policy containing message callbacks.
 * @param {Object} userDTO User input.
 * @param {Object} backendDTO Optional backend input.
 * @param {Array<string>} expectedErrors Exact expected error list.
 * @returns {{name:string,fileName:string,result:Object,failures:Array<string>}}
 */
function runContextCodeCase(name, policy, userDTO, backendDTO, expectedErrors) {
    var action = createValidatorAction();
    var result = action(policy, userDTO || {}, backendDTO || {}, systemShim);
    var actual = JSON.stringify(result.errors);
    var expected = JSON.stringify(expectedErrors);
    var failures = [];

    if (actual !== expected) {
        failures.push("expected errors=" + expected + " but got errors=" + actual);
    }

    return {
        name: name,
        fileName: "inline-" + name.replace(/\s+/g, "-"),
        result: result,
        failures: failures
    };
}

/**
 * Builds the JavaScript-only cases for stable validation context codes.
 *
 * @returns {Array<Object>} Executed test outcomes.
 */
function runContextCodeCases() {
    function codeAndReason(ctx) {
        return ctx.code + " | " + ctx.reason;
    }

    return [
        runContextCodeCase(
            "ctx code string regex",
            [{ path: "command", type: "string", regex: "^[a-z]+$", errorMessage: codeAndReason }],
            { command: "status;whoami" },
            {},
            ["string.regex | Value does not match regex"]
        ),
        runContextCodeCase(
            "ctx code string allowedValues",
            [{ path: "command", type: "string", allowedValues: ["start", "stop"], errorMessage: codeAndReason }],
            { command: "status" },
            {},
            ["string.allowedValues | Value is not in allowedValues"]
        ),
        runContextCodeCase(
            "ctx code number max",
            [{ path: "cpu", type: "number", max: 8, errorMessage: codeAndReason }],
            { cpu: 16 },
            {},
            ["number.max | Value is greater than max"]
        ),
        runContextCodeCase(
            "ctx code missing path",
            [{ path: "costCenter", type: "string", onMissing: "fail", missingMessage: codeAndReason }],
            {},
            {},
            ["path.missing | missing"]
        ),
        runContextCodeCase(
            "ctx code path resolution",
            [{ path: "items.name", type: "string", strictPath: true, errorMessage: codeAndReason }],
            { items: [{ name: "one" }] },
            {},
            ["path.resolve | pathResolveException"]
        ),
        runContextCodeCase(
            "ctx code anyMatch",
            [{ path: "tags[*]", type: "string", allowedValues: ["approved"], anyMatch: true, errorMessage: codeAndReason }],
            { tags: ["one", "two"] },
            {},
            ["rule.anyMatch | anyMatch"]
        ),
        runContextCodeCase(
            "ctx code object compare",
            [{ type: "object", leftPath: "selected", rightPath: "allowed", errorMessage: codeAndReason }],
            { selected: { name: "one" } },
            { allowed: { name: "two" } },
            ["object.compare | objectCompare"]
        )
    ];
}

/**
 * Ensures the validator does not mutate caller-owned rule objects.
 *
 * This uses a JavaScript policy instead of a JSON fixture so function-based
 * messages are also covered by the internal clone path.
 *
 * @returns {{name:string,fileName:string,result:Object,failures:Array<string>}}
 */
function runPolicyMutationIsolationCase() {
    var action = createValidatorAction();
    var messageFn = function () { return "Port must be allowed"; };
    var policy = [
        {
            path: "port",
            type: "number",
            allowedValues: ["22", "80-90"],
            notAllowedValues: ["23"],
            errorMessage: messageFn
        }
    ];
    var before = JSON.stringify(policy);
    var result = action(policy, { port: 22 }, {}, systemShim);
    var after = JSON.stringify(policy);
    var failures = [];

    if (result.valid !== true) {
        failures.push("expected valid=true but got valid=" + result.valid);
    }

    if (after !== before) {
        failures.push("policy was mutated from " + before + " to " + after);
    }

    if (policy[0].errorMessage !== messageFn) {
        failures.push("function-based errorMessage was not preserved on caller policy");
    }

    return {
        name: "policy mutation isolation",
        fileName: "inline-policy-mutation-isolation",
        result: result,
        failures: failures
    };
}

/**
 * Runs all JSON test cases and exits with a non-zero code if any case fails.
 *
 * @returns {void}
 */
function main() {
    var files = fs.readdirSync(casesDir).filter(function (fileName) {
        return /\.json$/i.test(fileName);
    }).sort();

    var failed = [];

    for (var i = 0; i < files.length; i++) {
        var outcome;

        try {
            outcome = runCase(files[i]);
        } catch (e) {
            failed.push({
                fileName: files[i],
                name: files[i],
                failures: [e && e.stack ? e.stack : String(e)]
            });
            console.log("FAIL " + files[i]);
            continue;
        }

        if (outcome.failures.length > 0) {
            failed.push(outcome);
            console.log("FAIL " + outcome.fileName + " - " + outcome.name);
            for (var f = 0; f < outcome.failures.length; f++) {
                console.log("  - " + outcome.failures[f]);
            }
            console.log("  result: " + JSON.stringify(outcome.result));
        } else {
            console.log("PASS " + outcome.fileName + " - " + outcome.name);
        }
    }

    var mutationOutcome = runPolicyMutationIsolationCase();
    if (mutationOutcome.failures.length > 0) {
        failed.push(mutationOutcome);
        console.log("FAIL " + mutationOutcome.fileName + " - " + mutationOutcome.name);
        for (var mf = 0; mf < mutationOutcome.failures.length; mf++) {
            console.log("  - " + mutationOutcome.failures[mf]);
        }
        console.log("  result: " + JSON.stringify(mutationOutcome.result));
    } else {
        console.log("PASS " + mutationOutcome.fileName + " - " + mutationOutcome.name);
    }

    var contextOutcomes = runContextCodeCases();
    for (var c = 0; c < contextOutcomes.length; c++) {
        var contextOutcome = contextOutcomes[c];
        if (contextOutcome.failures.length > 0) {
            failed.push(contextOutcome);
            console.log("FAIL " + contextOutcome.fileName + " - " + contextOutcome.name);
            for (var cf = 0; cf < contextOutcome.failures.length; cf++) {
                console.log("  - " + contextOutcome.failures[cf]);
            }
            console.log("  result: " + JSON.stringify(contextOutcome.result));
        } else {
            console.log("PASS " + contextOutcome.fileName + " - " + contextOutcome.name);
        }
    }

    console.log("");
    console.log("Executed " + (files.length + 1 + contextOutcomes.length) + " test case(s), " + failed.length + " failed.");

    if (failed.length > 0) {
        process.exit(1);
    }
}

main();
