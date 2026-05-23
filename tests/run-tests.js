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
 * The validator mutates some rule objects during normalization. Cloning keeps
 * test case data isolated between executions and mirrors the plain JSON nature
 * of the test fixtures.
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

    if (expected.warningIncludes) {
        var missingWarnings = containsAll(result.warnings, expected.warningIncludes);
        for (var w = 0; w < missingWarnings.length; w++) {
            failures.push("missing expected warning fragment: " + missingWarnings[w]);
        }
    }

    return {
        name: testCase.name || fileName,
        fileName: fileName,
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

    console.log("");
    console.log("Executed " + files.length + " test case(s), " + failed.length + " failed.");

    if (failed.length > 0) {
        process.exit(1);
    }
}

main();
