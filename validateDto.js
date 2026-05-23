// SPDX-License-Identifier: MIT

var result = validate(policy, userDTO, backendDTO);
return result;

// ============================================================================
// Message Resolution Helpers
// ============================================================================

/**
 * Creates a shallow merged context object.
 *
 * Existing keys from baseCtx are copied first, then extraCtx overwrites/adds keys.
 *
 * @param {Object} baseCtx
 * @param {Object} extraCtx
 * @returns {Object}
 */
function mergeContext(baseCtx, extraCtx) {
    var out = {};
    var k;

    if (baseCtx && typeof baseCtx === "object") {
        for (k in baseCtx) {
            if (Object.prototype.hasOwnProperty.call(baseCtx, k)) {
                out[k] = baseCtx[k];
            }
        }
    }

    if (extraCtx && typeof extraCtx === "object") {
        for (k in extraCtx) {
            if (Object.prototype.hasOwnProperty.call(extraCtx, k)) {
                out[k] = extraCtx[k];
            }
        }
    }

    return out;
}

/**
 * Resolves a configured message value.
 *
 * Supported forms:
 * - string: returned as-is
 * - function(ctx): invoked lazily and its return value is converted to string
 *
 * If the candidate is missing, throws, or returns null/undefined, the fallback
 * message is returned.
 *
 * @param {string|Function|*} messageCandidate
 * @param {string} fallback
 * @param {Object} ctx
 * @returns {string}
 */
function resolveConfiguredMessage(messageCandidate, fallback, ctx) {
    if (typeof messageCandidate === "function") {
        try {
            var result = messageCandidate(ctx || {});
            if (result === null || result === undefined) return fallback;
            return String(result);
        } catch (e) {
            return fallback;
        }
    }

    if (typeof messageCandidate === "string") {
        return messageCandidate;
    }

    return fallback;
}

/**
 * Resolves errorMessage from a rule/schema.
 *
 * @param {Object} source
 * @param {string} fallback
 * @param {Object} ctx
 * @returns {string}
 */
function resolveErrorMessage(source, fallback, ctx) {
    return resolveConfiguredMessage(source && source.errorMessage, fallback, ctx);
}

/**
 * Resolves missingMessage from a rule/schema.
 *
 * @param {Object} source
 * @param {string} fallback
 * @param {Object} ctx
 * @returns {string}
 */
function resolveMissingMessage(source, fallback, ctx) {
    return resolveConfiguredMessage(source && source.missingMessage, fallback, ctx);
}

/**
 * Resolves warningMessage from a rule/schema.
 *
 * If warningMessage is not configured, falls back to missingMessage for
 * compatibility with existing onMissing:"warn" policies.
 *
 * @param {Object} source
 * @param {string} fallback
 * @param {Object} ctx
 * @returns {string}
 */
function resolveWarningMessage(source, fallback, ctx) {
    var warning = resolveConfiguredMessage(source && source.warningMessage, null, ctx);
    if (warning !== null) return warning;
    return resolveMissingMessage(source, fallback, ctx);
}

// ============================================================================
// Pair-Compare (userDTO vs backendDTO) - Object/Array containment with recursion
// v1: objectMode + arrayDefault + optional arrayRules (no include/exclude yet)
// ============================================================================

/**
 * Validates that selected parts of userDTO are contained in backendDTO by comparing
 * two resolved roots (leftPath vs rightPath) and applying recursive object/array comparison.
 *
 * errorMessage may be a string or a function(ctx).
 *
 * @param {Object} rule
 * @param {Object} userDTO
 * @param {Object} backendDTO
 * @returns {{valid:boolean, error?:string}}
 */
function validateObjectPair(rule, userDTO, backendDTO) {
    /**
     * Creates a successful object-compare result.
     *
     * @returns {{valid:boolean}}
     */
    function ok() { return { valid: true }; }

    /**
     * Creates a failed object-compare result using the rule's configured message.
     *
     * @param {string} msg
     * @returns {{valid:boolean, error:string}}
     */
    function err(msg) {
        return {
            valid: false,
            error: resolveErrorMessage(rule, msg, {
                rule: rule,
                schema: rule,
                userDTO: userDTO,
                backendDTO: backendDTO,
                reason: msg
            })
        };
    }

    if (!userDTO || !backendDTO) {
        return err("Object-compare requires both userDTO and backendDTO.");
    }

    var leftRoots = rule.leftPath;
    var rightRoots = rule.rightPath;

    if (leftRoots === undefined || rightRoots === undefined) {
        return err("Object-compare requires leftPath and rightPath.");
    }

    leftRoots = Array.isArray(leftRoots) ? leftRoots : [leftRoots];
    rightRoots = Array.isArray(rightRoots) ? rightRoots : [rightRoots];

    if (leftRoots.length !== rightRoots.length) {
        return err("leftPath and rightPath must have the same number of entries.");
    }

    var objectMode = (rule.objectMode === "subset") ? "subset" : "deepEqual";

    var arrayDefault = rule.arrayDefault || {
        quantifier: "all",
        distinct: true
    };

    var arrayRules = Array.isArray(rule.arrayRules) ? rule.arrayRules : [];

    for (var i = 0; i < leftRoots.length; i++) {
        var lp = leftRoots[i];
        var rp = rightRoots[i];

        var leftVals = resolvePath(userDTO, lp, { strictPath: false });
        var rightVals = resolvePath(backendDTO, rp, { strictPath: false });

        var maxLen = Math.max(leftVals.length, rightVals.length);

        if (maxLen === 0) {
            var miss = "Missing compare root path(s): leftPath='" + lp + "', rightPath='" + rp + "'";
            return err(miss);
        }

        for (var k = 0; k < maxLen; k++) {
            var L = (leftVals.length > k) ? leftVals[k] : undefined;
            var R = (rightVals.length > k) ? rightVals[k] : undefined;

            var cmp = compareValue(L, R, lp, objectMode, arrayDefault, arrayRules);
            if (!cmp.ok) return err(cmp.msg || ("Mismatch at " + cmp.path));
        }
    }

    return ok();
}

/**
 * Compares two values recursively.
 *
 * @param {*} left
 * @param {*} right
 * @param {string} curPath
 * @param {"subset"|"deepEqual"} objectMode
 * @param {Object} arrayDefault
 * @param {Array<Object>} arrayRules
 * @returns {{ok:boolean, path?:string, msg?:string}}
 */
function compareValue(left, right, curPath, objectMode, arrayDefault, arrayRules) {
    if (left === right) return { ok: true };

    if (left === null || left === undefined) return { ok: false, path: curPath, msg: "Left is null/undefined" };
    if (right === null || right === undefined) return { ok: false, path: curPath, msg: "Right is null/undefined" };

    var leftIsArr = Array.isArray(left);
    var rightIsArr = Array.isArray(right);

    if (leftIsArr || rightIsArr) {
        if (!(leftIsArr && rightIsArr)) return { ok: false, path: curPath, msg: "Type mismatch (array vs non-array)" };
        var rule = getArrayRuleForPath(curPath, arrayDefault, arrayRules);
        return compareArraysContains(left, right, curPath, objectMode, arrayDefault, arrayRules, rule);
    }

    var leftType = typeof left;
    var rightType = typeof right;

    if (leftType !== rightType) return { ok: false, path: curPath, msg: "Type mismatch" };

    if (leftType !== "object") {
        return (left === right)
            ? { ok: true }
            : { ok: false, path: curPath, msg: "Value mismatch" };
    }

    return compareObjects(left, right, curPath, objectMode, arrayDefault, arrayRules);
}

/**
 * Compares two objects recursively using subset or deepEqual semantics.
 *
 * @param {Object} leftObj
 * @param {Object} rightObj
 * @param {string} curPath
 * @param {"subset"|"deepEqual"} objectMode
 * @param {Object} arrayDefault
 * @param {Array<Object>} arrayRules
 * @returns {{ok:boolean, path?:string, msg?:string}}
 */
function compareObjects(leftObj, rightObj, curPath, objectMode, arrayDefault, arrayRules) {
    for (var k in leftObj) {
        if (!Object.prototype.hasOwnProperty.call(leftObj, k)) continue;

        var nextPath = curPath ? (curPath + "." + k) : k;

        if (!Object.prototype.hasOwnProperty.call(rightObj, k)) {
            return { ok: false, path: nextPath, msg: "Missing key on right: " + k };
        }

        var cmp = compareValue(leftObj[k], rightObj[k], nextPath, objectMode, arrayDefault, arrayRules);
        if (!cmp.ok) return cmp;
    }

    if (objectMode === "deepEqual") {
        for (var r in rightObj) {
            if (!Object.prototype.hasOwnProperty.call(rightObj, r)) continue;
            if (!Object.prototype.hasOwnProperty.call(leftObj, r)) {
                var extraPath = curPath ? (curPath + "." + r) : r;
                return { ok: false, path: extraPath, msg: "Extra key on right: " + r };
            }
        }
    }

    return { ok: true };
}

/**
 * Resolves the applicable array rule for the current array path.
 * The most specific matching rule wins; if none matches, the default rule is used.
 *
 * @param {string} curPath
 * @param {Object} arrayDefault
 * @param {Array<Object>} arrayRules
 * @returns {Object}
 */
function getArrayRuleForPath(curPath, arrayDefault, arrayRules) {
    var best = null;
    var bestLen = -1;

    for (var i = 0; i < arrayRules.length; i++) {
        var r = arrayRules[i];
        if (!r || typeof r.path !== "string") continue;

        if (pathMatches(r.path, curPath)) {
            if (r.path.length > bestLen) {
                best = r;
                bestLen = r.path.length;
            }
        }
    }

    if (!best) return arrayDefault;

    var out = {};
    for (var k in arrayDefault) out[k] = arrayDefault[k];
    for (var kk in best) if (kk !== "path") out[kk] = best[kk];
    return out;
}

/**
 * Checks if a rule path matches a current path.
 * Numeric indices are normalized to [*] so that rules can be written once.
 *
 * @param {string} rulePath
 * @param {string} curPath
 * @returns {boolean}
 */
function pathMatches(rulePath, curPath) {
    /**
     * Normalizes concrete array indexes to wildcard notation for path matching.
     *
     * @param {string} p
     * @returns {string}
     */
    function norm(p) {
        return String(p).replace(/\[\d+\]/g, "[*]");
    }
    return norm(curPath).indexOf(norm(rulePath)) !== -1;
}

/**
 * Compares arrays using containment semantics, where membership is tested by deep comparison.
 *
 * @param {Array} leftArr
 * @param {Array} rightArr
 * @param {string} curPath
 * @param {"subset"|"deepEqual"} objectMode
 * @param {Object} arrayDefault
 * @param {Array<Object>} arrayRules
 * @param {Object} rule
 * @returns {{ok:boolean, path?:string, msg?:string}}
 */
function compareArraysContains(leftArr, rightArr, curPath, objectMode, arrayDefault, arrayRules, rule) {
    var quant = rule.quantifier || "all";
    var distinct = (rule.distinct === true);

    /**
     * Checks whether a left-side element is represented in the right-side array.
     *
     * @param {*} elem
     * @returns {boolean}
     */
    function elemFound(elem) {
        for (var j = 0; j < rightArr.length; j++) {
            var cmp = compareValue(elem, rightArr[j], curPath + "[*]", objectMode, arrayDefault, arrayRules);
            if (cmp.ok) return true;
        }
        return false;
    }

    var leftList = leftArr;
    if (distinct) {
        leftList = [];
        var seen = {};
        for (var i = 0; i < leftArr.length; i++) {
            var key = safeStableStringify(leftArr[i]);
            if (!seen[key]) { seen[key] = true; leftList.push(leftArr[i]); }
        }
    }

    for (var x = 0; x < leftList.length; x++) {
        var found = elemFound(leftList[x]);

        if (quant === "any" && found) return { ok: true };
        if (quant === "none" && found) return { ok: false, path: curPath, msg: "Array contains a forbidden element" };
        if (quant === "all" && !found) return { ok: false, path: curPath, msg: "Array is missing required element" };
    }

    if (quant === "any") return { ok: false, path: curPath, msg: "No array element matched but at least one was required" };
    return { ok: true };
}

/**
 * Creates a stable string representation of a value for deduplication purposes.
 *
 * @param {*} val
 * @returns {string}
 */
function safeStableStringify(val) {
    try {
        return stableStringify(val);
    } catch (e) {
        try { return JSON.stringify(val); } catch (e2) { return String(val); }
    }
}

/**
 * Deterministic JSON-like stringify:
 * - object keys are sorted
 * - arrays keep order
 *
 * @param {*} val
 * @returns {string}
 */
function stableStringify(val) {
    if (val === null) return "null";
    var t = typeof val;
    if (t === "number" || t === "boolean") return String(val);
    if (t === "string") return JSON.stringify(val);

    if (Array.isArray(val)) {
        var outA = [];
        for (var i = 0; i < val.length; i++) outA.push(stableStringify(val[i]));
        return "[" + outA.join(",") + "]";
    }

    if (t === "object") {
        var keys = [];
        for (var k in val) if (Object.prototype.hasOwnProperty.call(val, k)) keys.push(k);
        keys.sort();

        var outO = [];
        for (var j = 0; j < keys.length; j++) {
            var kk = keys[j];
            outO.push(JSON.stringify(kk) + ":" + stableStringify(val[kk]));
        }
        return "{" + outO.join(",") + "}";
    }

    return JSON.stringify(String(val));
}

/**
 * Tokenizes a path string into a sequence of tokens:
 * - {type:"prop", key:"name"}
 * - {type:"index", index:"*"} or {type:"index", index:0}
 *
 * Supported syntax examples:
 * - a.b.c
 * - a[0].b[*].c
 * - ["any.other.properties-yes"].key
 * - root["a.b"]["c-d"][0].x
 *
 * Limitations:
 * - Identifiers in dot notation are limited to [A-Za-z0-9_]
 * - Bracket notation supports single or double quotes.
 * - Minimal escape support inside quotes: \" \\ \n \t
 *
 * @param {string} path
 * @returns {Array<{type:"prop"|"index", key?:string, index?:number|string}>}
 */
function tokenizePath(path) {
    var tokens = [];
    var i = 0;

    /**
     * Checks whether a character is valid in dot-notation identifiers.
     *
     * @param {string} ch
     * @returns {boolean}
     */
    function isIdentChar(ch) {
        return /[A-Za-z0-9_]/.test(ch);
    }

    /**
     * Reads an identifier from the current parser position.
     *
     * @returns {string}
     */
    function readIdentifier() {
        var start = i;
        while (i < path.length && isIdentChar(path.charAt(i))) i++;
        return path.substring(start, i);
    }

    /**
     * Reads a quoted bracket-notation key from the current parser position.
     *
     * @returns {string|null}
     */
    function readQuotedString() {
        var quote = path.charAt(i);
        i++;
        var out = "";
        while (i < path.length) {
            var ch = path.charAt(i);
            if (ch === "\\") {
                var nxt = path.charAt(i + 1);
                if (nxt === "n") out += "\n";
                else if (nxt === "t") out += "\t";
                else out += nxt;
                i += 2;
                continue;
            }
            if (ch === quote) {
                i++;
                return out;
            }
            out += ch;
            i++;
        }
        return null;
    }

    while (i < path.length) {
        var ch = path.charAt(i);

        if (ch === ".") { i++; continue; }
        if (/\s/.test(ch)) { i++; continue; }

        if (ch === "[") {
            i++;
            while (i < path.length && /\s/.test(path.charAt(i))) i++;

            if (i >= path.length) throw new Error("Invalid path: unterminated '['");

            var inner = path.charAt(i);

            if (inner === "\"" || inner === "'") {
                var key = readQuotedString();
                if (key === null) throw new Error("Invalid path: unterminated string in brackets");
                while (i < path.length && /\s/.test(path.charAt(i))) i++;
                if (path.charAt(i) !== "]") throw new Error("Invalid path: missing closing ]");
                i++;
                tokens.push({ type: "prop", key: key });
                continue;
            }

            if (inner === "*") {
                i++;
                while (i < path.length && /\s/.test(path.charAt(i))) i++;
                if (path.charAt(i) !== "]") throw new Error("Invalid path: missing closing ]");
                i++;
                tokens.push({ type: "index", index: "*" });
                continue;
            }

            var numStart = i;
            while (i < path.length && /[0-9]/.test(path.charAt(i))) i++;
            if (numStart === i) throw new Error("Invalid path: expected index, * or quoted key in []");
            var idx = parseInt(path.substring(numStart, i), 10);
            while (i < path.length && /\s/.test(path.charAt(i))) i++;
            if (path.charAt(i) !== "]") throw new Error("Invalid path: missing closing ]");
            i++;
            tokens.push({ type: "index", index: idx });
            continue;
        }

        if (isIdentChar(ch)) {
            var ident = readIdentifier();
            tokens.push({ type: "prop", key: ident });
            continue;
        }

        throw new Error("Invalid path: unexpected character '" + ch + "'");
    }

    return tokens;
}

/**
 * Resolves a path against a DTO and returns all matched values.
 *
 * - Uses tokenizePath() so it supports bracket notation keys (dots/hyphens/etc).
 * - Supports array expansion via [*] and selection via [n].
 * - strictPath: if a property resolves to an array, the next token must be
 *   an index token; otherwise an error is thrown.
 *
 * @param {Object} dto
 * @param {string} path
 * @param {{strictPath?:boolean}} options
 * @returns {Array<*>}
 */
function resolvePath(dto, path, options) {
    if (typeof path !== "string") return [];
    options = options || {};

    var tokens = tokenizePath(path);
    var values = [dto];

    for (var t = 0; t < tokens.length; t++) {
        var tok = tokens[t];
        var nextValues = [];

        for (var j = 0; j < values.length; j++) {
            var obj = values[j];
            if (obj === null || obj === undefined) continue;

            if (tok.type === "prop") {
                if (typeof obj !== "object") continue;

                var val = obj[tok.key];

                if (options.strictPath === true && Array.isArray(val)) {
                    var nextTok = tokens[t + 1];
                    if (!nextTok || nextTok.type !== "index") {
                        throw new Error(
                            "Invalid path '" + path + "': segment '" + tok.key + "' is an array but no [*] or [n] was specified."
                        );
                    }
                }

                if (val !== undefined) nextValues.push(val);
                continue;
            }

            if (tok.type === "index") {
                if (!Array.isArray(obj)) continue;

                if (tok.index === "*") {
                    nextValues = nextValues.concat(obj);
                } else {
                    if (obj.length > tok.index) {
                        var item = obj[tok.index];
                        if (item !== undefined) nextValues.push(item);
                    }
                }
                continue;
            }
        }

        values = nextValues;
    }

    return values;
}

/**
 * Resolves multiple fields and joins them by index.
 *
 * Typical use: join port + port_end into "4609-4615".
 *
 * @param {Object} dto
 * @param {Array<string>} fields
 * @param {string} separator
 * @returns {Array<string>}
 */
function resolveJoinedValue(dto, fields, separator) {
    var allValues = [];
    var maxLength = 0;

    // Resolve all source fields first so indexed values can be joined row-wise.
    for (var i = 0; i < fields.length; i++) {
        var resolved = resolvePath(dto, fields[i]);
        allValues.push(resolved);
        if (resolved.length > maxLength) {
            maxLength = resolved.length;
        }
    }

    var result = [];

    for (var ii = 0; ii < maxLength; ii++) {
        var parts = [];
        var validPartCount = 0;

        for (var j = 0; j < allValues.length; j++) {
            var arr = allValues[j];
            var part = (arr && arr.length > ii) ? arr[ii] : null;

            if (part !== null && part !== undefined && part !== "") {
                validPartCount++;
                parts.push(part);
            } else {
                parts.push("");
            }
        }

        if (validPartCount === fields.length) {
            result.push(parts.join(separator || "-"));
        } else if (validPartCount === 1 && parts.length === 1) {
            result.push(parts[0]);
        } else if (validPartCount === 1 && parts.length > 1) {
            for (var k = 0; k < parts.length; k++) {
                if (parts[k] !== "") {
                    result.push(parts[k]);
                    break;
                }
            }
        }
    }

    return result;
}

// ============================================================================
// Allowed Values Helpers + Type-derived Enforcement
// ============================================================================

/**
 * Normalizes allowedValues entries by converting numeric strings to numbers and
 * range strings to compact range notation (e.g. "80 - 443" -> "80-443").
 *
 * @param {*} list
 * @returns {*}
 */
function normalizeAllowedValues(list) {
    if (!Array.isArray(list)) return list;

    var out = [];
    for (var i = 0; i < list.length; i++) {
        var v = list[i];

        if (typeof v === "number") {
            out.push(v);
            continue;
        }

        if (typeof v === "string") {
            var s = v.trim();

            if (/^-?\d+(\.\d+)?\s*-\s*-?\d+(\.\d+)?$/.test(s)) {
                out.push(s.replace(/\s+/g, ""));
                continue;
            }

            if (/^-?\d+(\.\d+)?$/.test(s)) {
                out.push(parseFloat(s));
                continue;
            }

            out.push(v);
            continue;
        }

        out.push(v);
    }

    return out;
}

/**
 * Normalizes allowedValues based on schema.type.
 *
 * @param {*} list
 * @param {Object} schema
 * @returns {*}
 */
function normalizeAllowedValuesByType(list, schema) {
    if (!Array.isArray(list)) return list;

    var type = schema && schema.type;

    if (type === "string") {
        var outS = [];
        for (var i = 0; i < list.length; i++) {
            if (typeof list[i] !== "string") outS.push(String(list[i]));
            else outS.push(list[i]);
        }
        return outS;
    }

    if (type === "number") {
        return normalizeAllowedValues(list);
    }

    return list;
}

/**
 * Validates that allowedValues has a valid type/shape according to schema.type.
 *
 * @param {Object} schema
 * @returns {{ok:boolean, msg?:string}}
 */
function assertAllowedValuesType(schema) {
    if (!schema || !schema.allowedValues) return { ok: true };

    if (!Array.isArray(schema.allowedValues)) {
        return { ok: false, msg: "allowedValues must be an array" };
    }

    if (schema.type === "number") {
        var list = schema.allowedValues;
        for (var i = 0; i < list.length; i++) {
            var v = list[i];
            if (typeof v === "number") continue;

            if (typeof v === "string") {
                var s = v.trim();
                if (/^-?\d+(\.\d+)?$/.test(s)) continue;
                if (/^-?\d+(\.\d+)?\s*-\s*-?\d+(\.\d+)?$/.test(s)) continue;
            }

            return { ok: false, msg: "allowedValues for type:number must contain only numbers or range strings" };
        }
        return { ok: true };
    }

    if (schema.type === "string") {
        for (var j = 0; j < schema.allowedValues.length; j++) {
            if (typeof schema.allowedValues[j] !== "string") {
                return { ok: false, msg: "allowedValues for type:string must contain only strings" };
            }
        }
        return { ok: true };
    }

    if (schema.type === "boolean" || schema.type === "date") {
        return { ok: false, msg: "allowedValues is not supported for type:" + schema.type };
    }

    return { ok: true };
}

// ============================================================================
// Core allowedValues evaluation (legacy helper)
// ============================================================================

/**
 * Checks whether a value is allowed by an allowed list of numbers and/or inclusive ranges.
 *
 * @param {*} valueString
 * @param {Array<string|number>} allowedList
 * @param {Object} schema
 * @returns {boolean}
 */
function isAllowedValue(valueString, allowedList, schema) {
    if (!Array.isArray(allowedList)) return false;

    var isStringList = typeof allowedList[0] === "string";

    if (typeof valueString === "string") {
        if (isStringList) {
            for (var i = 0; i < allowedList.length; i++) {
                if (valueString === allowedList[i]) return true;
            }
            return false;
        }

        if (valueString.indexOf("-") !== -1 && !isStringList) return false;

        var parsed = parseFloat(valueString);
        if (!isNaN(parsed)) {
            for (var j = 0; j < allowedList.length; j++) {
                if (parsed === allowedList[j]) return true;
            }
        }
        return false;
    }

    if (typeof valueString !== "number") {
        if (!/^-?\d+(\.\d+)?$/.test(valueString)) return false;
        valueString = parseFloat(valueString);
    }

    for (var k = 0; k < allowedList.length; k++) {
        var range = allowedList[k];
        if (typeof range === "string" && range.indexOf("-") !== -1) {
            var parts = range.split("-");
            var min = parseFloat(parts[0]);
            var max = parseFloat(parts[1]);
            if (valueString >= min && valueString <= max) return true;
        } else if (typeof range === "number" && valueString === range) {
            return true;
        }
    }

    return false;
}

/**
 * Alias for isAllowedValue.
 *
 * @param {*} valueString
 * @param {Array<string|number>} allowedList
 * @param {Object} schema
 * @returns {boolean}
 */
function isValueInRangeList(valueString, allowedList, schema) {
    return isAllowedValue(valueString, allowedList, schema);
}

// ============================================================================
// Range/Coverage logic (inclusive ranges)
// ============================================================================

/**
 * Checks if a string is a number range like "80-443".
 *
 * @param {*} s
 * @returns {boolean}
 */
function isNumberRangeString(s) {
    if (typeof s !== "string") return false;
    s = s.trim();
    return /^\d+(\.\d+)?\s*-\s*\d+(\.\d+)?$/.test(s);
}

/**
 * Parses a numeric range string into {min,max}.
 *
 * @param {string} s
 * @returns {{min:number,max:number}|null}
 */
function parseRangeString(s) {
    var cleaned = s.replace(/\s+/g, "");
    var parts = cleaned.split("-");
    if (parts.length !== 2) return null;
    if (!/^\d+(\.\d+)?$/.test(parts[0]) || !/^\d+(\.\d+)?$/.test(parts[1])) return null;

    var a = parseFloat(parts[0]);
    var b = parseFloat(parts[1]);
    if (isNaN(a) || isNaN(b)) return null;
    if (a > b) { var t = a; a = b; b = t; }
    return { min: a, max: b };
}

/**
 * @param {*} n
 * @returns {boolean}
 */
function isIntegerLikeNumber(n) {
    return typeof n === "number" && isFinite(n) && (n % 1 === 0);
}

/**
 * Checks whether a numeric allowedValues token represents only integer values.
 *
 * @param {*} token
 * @returns {boolean}
 */
function looksIntegerLikeRangeToken(token) {
    if (typeof token === "number") return isIntegerLikeNumber(token);
    if (typeof token !== "string") return false;

    var s = token.replace(/\s+/g, "");
    if (s.indexOf(".") !== -1) return false;

    if (/^\d+$/.test(s)) return true;
    if (/^\d+-\d+$/.test(s)) return true;

    return false;
}

/**
 * Infers integer-mode if allowedValues contain only integer-like tokens.
 *
 * @param {Array<*>} allowedValues
 * @param {*} value
 * @returns {boolean}
 */
function inferIntegerMode(allowedValues, value) {
    if (typeof value === "string" && value.indexOf(".") !== -1) return false;
    if (!Array.isArray(allowedValues)) return false;

    for (var i = 0; i < allowedValues.length; i++) {
        if (!looksIntegerLikeRangeToken(allowedValues[i])) return false;
    }
    return true;
}

/**
 * Parses allowedValues into numeric intervals and merges them.
 *
 * @param {Array<*>} allowedValues
 * @param {boolean} integerMode
 * @returns {Array<{min:number,max:number}>}
 */
function parseAllowedIntervals(allowedValues, integerMode) {
    var intervals = [];
    if (!Array.isArray(allowedValues)) return intervals;

    for (var i = 0; i < allowedValues.length; i++) {
        var v = allowedValues[i];

        if (typeof v === "number") {
            intervals.push({ min: v, max: v });
            continue;
        }

        if (typeof v === "string") {
            var s = v.replace(/\s+/g, "");

            if (s.indexOf("-") !== -1) {
                var r = parseRangeString(s);
                if (r) {
                    intervals.push({ min: r.min, max: r.max });
                    continue;
                }
            }

            if (/^\d+(\.\d+)?$/.test(s)) {
                var n = parseFloat(s);
                if (!isNaN(n)) intervals.push({ min: n, max: n });
                continue;
            }
        }
    }

    return mergeIntervals(intervals, integerMode === true);
}

/**
 * Merges overlapping/touching intervals.
 *
 * @param {Array<{min:number,max:number}>} intervals
 * @param {boolean} integerMode
 * @returns {Array<{min:number,max:number}>}
 */
function mergeIntervals(intervals, integerMode) {
    if (!intervals || intervals.length === 0) return [];

    // Sort before merging so coverage checks can scan intervals from left to right.
    intervals.sort(function (a, b) {
        if (a.min < b.min) return -1;
        if (a.min > b.min) return 1;
        if (a.max < b.max) return -1;
        if (a.max > b.max) return 1;
        return 0;
    });

    var merged = [{ min: intervals[0].min, max: intervals[0].max }];

    for (var i = 1; i < intervals.length; i++) {
        var cur = intervals[i];
        var last = merged[merged.length - 1];

        var canMerge = integerMode ? (cur.min <= last.max + 1) : (cur.min <= last.max);

        if (canMerge) {
            if (cur.max > last.max) last.max = cur.max;
        } else {
            merged.push({ min: cur.min, max: cur.max });
        }
    }

    return merged;
}

/**
 * Checks whether a point is covered by one of the inclusive intervals.
 *
 * @param {number} x
 * @param {Array<{min:number,max:number}>} intervals
 * @returns {boolean}
 */
function isPointCovered(x, intervals) {
    for (var i = 0; i < intervals.length; i++) {
        if (x >= intervals[i].min && x <= intervals[i].max) return true;
    }
    return false;
}

/**
 * Checks whether every value in an inclusive range is covered by the intervals.
 *
 * @param {number} a
 * @param {number} b
 * @param {Array<{min:number,max:number}>} intervals
 * @param {boolean} integerMode
 * @returns {boolean}
 */
function isRangeFullyCovered(a, b, intervals, integerMode) {
    if (a > b) { var t = a; a = b; b = t; }

    var pos = a;

    // Walk merged intervals in order and fail as soon as a gap before b is found.
    for (var i = 0; i < intervals.length; i++) {
        var it = intervals[i];

        if (it.max < pos) continue;

        if (it.min > pos) return false;

        pos = it.max;

        if (pos >= b) return true;

        if (integerMode) pos = pos + 1;
    }

    return false;
}

/**
 * Validates that a numeric value or numeric range is fully covered by allowedValues.
 *
 * errorMessage may be a string or a function(ctx).
 *
 * @param {*} value
 * @param {Object} schema
 * @returns {{valid:boolean, error?:string}}
 */
function validateAllowedValuesCoverage(value, schema) {
    /**
     * Creates a successful coverage result.
     *
     * @returns {{valid:boolean}}
     */
    function ok() { return { valid: true }; }

    /**
     * Creates a failed coverage result using the schema's configured message.
     *
     * @param {string} msg
     * @returns {{valid:boolean, error:string}}
     */
    function err(msg) {
        return {
            valid: false,
            error: resolveErrorMessage(schema, msg, {
                rule: schema,
                schema: schema,
                value: value,
                reason: msg
            })
        };
    }

    if (!schema.allowedValues || !Array.isArray(schema.allowedValues)) {
        return err("allowedValues must be an array");
    }

    schema.allowedValues = normalizeAllowedValues(schema.allowedValues);

    var integerMode = (schema.integerOnly === true) ? true : inferIntegerMode(schema.allowedValues, value);

    var intervals = parseAllowedIntervals(schema.allowedValues, integerMode);
    if (!intervals || intervals.length === 0) {
        return err("allowedValues is empty or invalid");
    }

    if (typeof value === "string" && isNumberRangeString(value)) {
        var r = parseRangeString(value);
        if (!r) return err("Invalid range format");

        if (!isRangeFullyCovered(r.min, r.max, intervals, integerMode)) {
            return err("Range is not fully covered by allowedValues");
        }
        return ok();
    }

    var num = value;
    if (typeof num !== "number") {
        if (typeof num !== "string" || !/^\d+(\.\d+)?$/.test(num)) return err("Value is not a valid number format");
        num = parseFloat(num);
        if (isNaN(num)) return err("Value is not a number");
    }

    if (!isPointCovered(num, intervals)) {
        return err("Value is not covered by allowedValues");
    }

    return ok();
}

// ============================================================================
// Validators
// ============================================================================

/**
 * Validates a string value against schema constraints.
 *
 * errorMessage may be a string or a function(ctx).
 *
 * @param {*} value
 * @param {Object} schema
 * @returns {{valid:boolean, error?:string}}
 */
function validateString(value, schema) {
    /**
     * Builds a RegExp from either a RegExp object or a string pattern.
     *
     * @param {RegExp|string} input
     * @param {string} flags
     * @returns {RegExp}
     */
    function extractPattern(input, flags) {
        if (input instanceof RegExp) {
            return new RegExp(input.source, flags || input.flags || "");
        } else {
            return new RegExp(input, flags || "");
        }
    }

    /**
     * Creates a failed string-validation result using the schema's configured message.
     *
     * @param {string} message
     * @returns {{valid:boolean, error:string}}
     */
    function error(message) {
        return {
            valid: false,
            error: resolveErrorMessage(schema, message, {
                rule: schema,
                schema: schema,
                value: value,
                reason: message
            })
        };
    }

    if (schema.allowed && !schema.anyOf) {
        schema.anyOf = [];
        for (var i = 0; i < schema.allowed.length; i++) {
            schema.anyOf.push({ "const": schema.allowed[i] });
        }
    }

    if (value === null || value === "") {
        if (schema.nullOrEmpty === true) return { valid: true };
        return error("Value is null or empty");
    }

    if (typeof value !== "string") {
        return error("Value is not a string");
    }

    if (schema.trim) value = value.trim();

    if (schema.minLength && value.length < schema.minLength) return error("Value is shorter than minLength");
    if (schema.maxLength && value.length > schema.maxLength) return error("Value is longer than maxLength");
    if (schema.length !== undefined && value.length !== schema.length) return error("Value does not match required length");

    if (schema.regex) {
        var regexFlags = schema.ignoreCase ? "i" : "";
        var pattern = extractPattern(schema.regex, regexFlags);
        if (!pattern.test(value)) return error("Value does not match regex");
    }

    if (schema.eq !== undefined) {
        if (schema.ignoreCase && typeof schema.eq === "string") {
            if (value.toLowerCase() !== schema.eq.toLowerCase()) return error("Value does not equal expected string (case-insensitive)");
        } else {
            if (value !== schema.eq) return error("Value does not equal expected string");
        }
    }

    if (schema.neq !== undefined) {
        if (schema.ignoreCase && typeof schema.neq === "string") {
            if (value.toLowerCase() === schema.neq.toLowerCase()) return error("Value must not equal disallowed string (case-insensitive)");
        } else {
            if (value === schema.neq) return error("Value must not equal disallowed string");
        }
    }

    if (schema.startsWith !== undefined) {
        var target = schema.ignoreCase ? value.toLowerCase() : value;
        var compare = schema.ignoreCase ? schema.startsWith.toLowerCase() : schema.startsWith;
        if (!target.startsWith(compare)) return error("Value does not start with expected string");
    }

    if (schema.endsWith !== undefined) {
        var target2 = schema.ignoreCase ? value.toLowerCase() : value;
        var compare2 = schema.ignoreCase ? schema.endsWith.toLowerCase() : schema.endsWith;
        if (!target2.endsWith(compare2)) return error("Value does not end with expected string");
    }

    if (schema.contains !== undefined) {
        var target3 = schema.ignoreCase ? value.toLowerCase() : value;
        var compare3 = schema.ignoreCase ? schema.contains.toLowerCase() : schema.contains;
        if (target3.indexOf(compare3) === -1) return error("Value does not contain expected substring");
    }

    if (schema.notContains !== undefined) {
        var target4 = schema.ignoreCase ? value.toLowerCase() : value;
        var compare4 = schema.ignoreCase ? schema.notContains.toLowerCase() : schema.notContains;
        if (target4.indexOf(compare4) !== -1) return error("Value must not contain disallowed substring");
    }

    if (schema.anyOf) {
        var match = false;
        for (var j = 0; j < schema.anyOf.length; j++) {
            var cond = schema.anyOf[j];
            if (cond.const !== undefined) {
                if (schema.ignoreCase && typeof cond.const === "string") {
                    if (value.toLowerCase() === cond.const.toLowerCase()) { match = true; break; }
                } else {
                    if (value === cond.const) { match = true; break; }
                }
            }
            if (cond.regex) {
                var flags = schema.ignoreCase ? "i" : "";
                var rx = extractPattern(cond.regex, flags);
                if (rx.test(value)) { match = true; break; }
            }
            if (cond.type === "string") { match = true; break; }
        }
        if (!match) return error("Value does not match anyOf conditions");
    }

    if (schema.allowedValues) {
        var chk = assertAllowedValuesType(schema);
        if (!chk.ok) return error(chk.msg);

        schema.allowedValues = normalizeAllowedValuesByType(schema.allowedValues, schema);

        for (var a = 0; a < schema.allowedValues.length; a++) {
            if (value === schema.allowedValues[a]) return { valid: true };
        }
        return error("Value is not in allowedValues");
    }

    return { valid: true };
}

/**
 * Validates a numeric value (supports optional range input when configured).
 *
 * errorMessage may be a string or a function(ctx).
 *
 * @param {*} value
 * @param {Object} schema
 * @returns {{valid:boolean, error?:string}}
 */
function validateNumber(value, schema) {
    /**
     * Creates a failed number-validation result using the schema's configured message.
     *
     * @param {string} message
     * @returns {{valid:boolean, error:string}}
     */
    function error(message) {
        return {
            valid: false,
            error: resolveErrorMessage(schema, message, {
                rule: schema,
                schema: schema,
                value: value,
                reason: message
            })
        };
    }

    if (value === null || value === "") {
        if (schema.nullOrEmpty === true) return { valid: true };
        return error("Value is null or empty");
    }

    var allowRange = (schema.allowRangeInput === true) ||
        (schema.join && typeof value === "string" && isNumberRangeString(value));

    // Range input is validated as coverage against allowedValues, not as one scalar number.
    if (allowRange && typeof value === "string" && isNumberRangeString(value)) {
        if (!schema.allowedValues) return error("Range input requires allowedValues");

        if (schema.gt !== undefined || schema.gte !== undefined || schema.lt !== undefined || schema.lte !== undefined ||
            schema.min !== undefined || schema.max !== undefined || schema.eq !== undefined || schema.neq !== undefined ||
            schema.multipleOf !== undefined) {
            return error("Range input cannot be combined with numeric comparisons (gt/lt/min/max/eq/neq/multipleOf)");
        }

        var chkR = assertAllowedValuesType(schema);
        if (!chkR.ok) return error(chkR.msg);

        schema.allowedValues = normalizeAllowedValuesByType(schema.allowedValues, schema);

        return validateAllowedValuesCoverage(value, schema);
    }

    if (typeof value !== "number") {
        if (typeof value !== "string" || !/^\d+(\.\d+)?$/.test(value)) {
            return error("Value is not a valid number format");
        }
        var parsed = parseFloat(value);
        if (isNaN(parsed)) return error("Value is not a number");
        value = parsed;
    }

    if (schema.integerOnly === true && value % 1 !== 0) return error("Value must be an integer");

    if (schema.between && schema.between.length === 2) {
        schema.min = parseFloat(schema.between[0]);
        schema.max = parseFloat(schema.between[1]);
    }

    if (schema.min !== undefined && value < parseFloat(schema.min)) return error("Value is less than min");
    if (schema.max !== undefined && value > parseFloat(schema.max)) return error("Value is greater than max");
    if (schema.gt !== undefined && !(value > parseFloat(schema.gt))) return error("Value must be greater than gt");
    if (schema.gte !== undefined && !(value >= parseFloat(schema.gte))) return error("Value must be greater or equal to gte");
    if (schema.lt !== undefined && !(value < parseFloat(schema.lt))) return error("Value must be less than lt");
    if (schema.lte !== undefined && !(value <= parseFloat(schema.lte))) return error("Value must be less or equal to lte");
    if (schema.eq !== undefined && value !== parseFloat(schema.eq)) return error("Value must equal eq");
    if (schema.neq !== undefined && value === parseFloat(schema.neq)) return error("Value must not equal neq");
    if (schema.multipleOf !== undefined && value % parseFloat(schema.multipleOf) !== 0) return error("Value must be a multipleOf " + schema.multipleOf);

    if (schema.allowedValues) {
        var chk = assertAllowedValuesType(schema);
        if (!chk.ok) return error(chk.msg);

        schema.allowedValues = normalizeAllowedValuesByType(schema.allowedValues, schema);

        var res = validateAllowedValuesCoverage(value, schema);
        if (!res.valid) return { valid: false, error: res.error };
    }

    if (schema.notAllowedValues) {
        schema.notAllowedValues = normalizeAllowedValues(schema.notAllowedValues);
        if (isValueInRangeList(value, schema.notAllowedValues, schema)) {
            return error("Value is in notAllowedValues");
        }
    }

    return { valid: true };
}

/**
 * Validates a boolean value.
 *
 * errorMessage may be a string or a function(ctx).
 *
 * @param {*} value
 * @param {Object} schema
 * @returns {{valid:boolean, error?:string}}
 */
function validateBoolean(value, schema) {
    /**
     * Creates a failed boolean-validation result using the schema's configured message.
     *
     * @param {string} message
     * @returns {{valid:boolean, error:string}}
     */
    function error(message) {
        return {
            valid: false,
            error: resolveErrorMessage(schema, message, {
                rule: schema,
                schema: schema,
                value: value,
                reason: message
            })
        };
    }

    if (typeof value === "string") {
        var v = value.toLowerCase();
        if (v === "true" || v === "1") value = true;
        else if (v === "false" || v === "0") value = false;
        else return error("Invalid boolean string");
    }

    if (typeof value === "number") {
        if (value === 1) value = true;
        else if (value === 0) value = false;
        else return error("Invalid numeric boolean");
    }

    if (typeof value !== "boolean") return error("Value is not a boolean");

    if (schema.eq !== undefined && value !== schema.eq) return error("Boolean does not match expected value");
    if (schema.neq !== undefined && value === schema.neq) return error("Boolean must not match disallowed value");

    return { valid: true };
}

/**
 * Validates a date input.
 *
 * errorMessage may be a string or a function(ctx).
 *
 * @param {*} value
 * @param {Object} schema
 * @returns {{valid:boolean, error?:string}}
 */
function validateDate(value, schema) {
    /**
     * Creates a failed date-validation result using the schema's configured message.
     *
     * @param {string} message
     * @returns {{valid:boolean, error:string}}
     */
    function error(message) {
        return {
            valid: false,
            error: resolveErrorMessage(schema, message, {
                rule: schema,
                schema: schema,
                value: value,
                reason: message
            })
        };
    }

    if (value === null || value === "") {
        if (schema.nullOrEmpty === true) return { valid: true };
        return error("Date value is null or empty");
    }

    var dateObj = null;

    if (Object.prototype.toString.call(value) === "[object Date]") {
        dateObj = value;
    } else if (typeof value === "string") {
        var parsedDate = new Date(value);
        if (isNaN(parsedDate.getTime())) return error("Invalid date string");
        dateObj = parsedDate;
    } else {
        return error("Unsupported date format");
    }

    var now = new Date();
    var refDate = null;

    if (schema.referenceDate) {
        if (Object.prototype.toString.call(schema.referenceDate) === "[object Date]") {
            refDate = schema.referenceDate;
        } else if (typeof schema.referenceDate === "string") {
            var refParsed = new Date(schema.referenceDate);
            if (!isNaN(refParsed.getTime())) refDate = refParsed;
        }
    }

    var compareTo = refDate || now;

    if (typeof schema.offset === "number") {
        var targetTime = compareTo.getTime() + schema.offset * 1000;
        var actualTime = dateObj.getTime();
        var tolerance = typeof schema.offsetTolerance === "number" ? schema.offsetTolerance : 0;
        var delta = Math.abs(actualTime - targetTime);
        if (delta > tolerance) return error("Date is outside of allowed offset tolerance");
    }

    if (schema.eq) {
        var eqDate = null;
        if (Object.prototype.toString.call(schema.eq) === "[object Date]") eqDate = schema.eq;
        else if (typeof schema.eq === "string") {
            var eqParsed = new Date(schema.eq);
            if (!isNaN(eqParsed.getTime())) eqDate = eqParsed;
        }
        if (!eqDate || dateObj.getTime() !== eqDate.getTime()) return error("Date must equal expected value");
    }

    if (schema.min) {
        var minDate = Object.prototype.toString.call(schema.min) === "[object Date]" ? schema.min : new System.getDateFromFormat(schema.min);
        if (isNaN(minDate.getTime()) || dateObj < minDate) return error("Date is before minimum allowed");
    }

    if (schema.max) {
        var maxDate = Object.prototype.toString.call(schema.max) === "[object Date]"
            ? new Date(schema.max)
            : new Date(System.getDateFromFormat(schema.max));

        if (isNaN(maxDate.getTime())) return error("Invalid max date");
        if (dateObj > maxDate) return error("Date is after maximum allowed");
    }

    if (schema.gt && !(dateObj > compareTo)) return error("Date must be greater than reference");
    if (schema.gte && !(dateObj >= compareTo)) return error("Date must be greater than or equal to reference");
    if (schema.lt && !(dateObj < compareTo)) return error("Date must be less than reference");
    if (schema.lte && !(dateObj <= compareTo)) return error("Date must be less than or equal to reference");

    return { valid: true };
}

/**
 * Dispatches validation based on schema.type.
 *
 * @param {*} value
 * @param {Object} schema
 * @returns {{valid:boolean, error?:string}}
 */
function validateValueByType(value, schema) {
    if (schema.type === "number") return validateNumber(value, schema);
    if (schema.type === "string") return validateString(value, schema);
    if (schema.type === "boolean") return validateBoolean(value, schema);
    if (schema.type === "date") return validateDate(value, schema);
    return { valid: true };
}

// ============================================================================
// Coercion
// ============================================================================

/**
 * Coerces a value according to schema.type where safe/appropriate.
 *
 * @param {*} value
 * @param {Object} schema
 * @returns {*}
 */
function coerceValueByType(value, schema) {
    if (value === null || value === undefined || value === "") return value;

    if (schema && schema.trim === true && typeof value === "string") {
        value = value.trim();
    }

    if (!schema || !schema.type) return value;

    if (schema.type === "number") {
        if (typeof value === "number") return value;

        if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value)) {
            var parsed = parseFloat(value);
            return isNaN(parsed) ? value : parsed;
        }

        return value;
    }

    return value;
}

// ============================================================================
// Multi-Rule DTO Validation (supports anyMatch/noneMatch per rule)
// ============================================================================

/**
 * Validates a userDTO against a list of rules. Primitive rules are evaluated against userDTO only.
 * Object-compare rules (type:"object") are evaluated against userDTO vs backendDTO.
 *
 * errorMessage and missingMessage may be strings or functions(ctx).
 *
 * @param {Object} userDTO
 * @param {Object} backendDTO
 * @param {Array<Object>} rules
 * @returns {{valid:boolean, errors:Array<string>, warnings:Array<string>}}
 */
function validateDtoMulti(userDTO, backendDTO, rules) {
    var allErrors = [];
    var allWarnings = [];

    /**
     * Adds a non-empty message once to the target message list.
     *
     * @param {Array<string>} arr
     * @param {*} msg
     * @returns {void}
     */
    function addUnique(arr, msg) {
        if (msg === null || msg === undefined) return;
        msg = String(msg);
        if (arr.indexOf(msg) === -1) arr.push(msg);
    }

    /**
     * Creates the shared message context for a policy rule.
     *
     * @param {Object} rule
     * @returns {Object}
     */
    function getRuleBaseContext(rule) {
        return {
            rule: rule,
            schema: rule,
            userDTO: userDTO,
            backendDTO: backendDTO
        };
    }

    /**
     * Adds a resolved error message for a rule.
     *
     * @param {Object} rule
     * @param {string} fallback
     * @param {Object} extraCtx
     * @returns {void}
     */
    function addRuleError(rule, fallback, extraCtx) {
        addUnique(
            allErrors,
            resolveErrorMessage(rule, fallback, mergeContext(getRuleBaseContext(rule), extraCtx))
        );
    }

    /**
     * Adds a resolved warning message for a rule.
     *
     * @param {Object} rule
     * @param {string} fallback
     * @param {Object} extraCtx
     * @returns {void}
     */
    function addRuleWarning(rule, fallback, extraCtx) {
        addUnique(
            allWarnings,
            resolveConfiguredMessage(rule && rule.warningMessage, fallback, mergeContext(getRuleBaseContext(rule), extraCtx))
        );
    }

    /**
     * Applies the rule's onMissing behavior for unresolved paths.
     *
     * @param {Object} rule
     * @param {string} pathsText
     * @returns {void}
     */
    function addMissing(rule, pathsText) {
        var onMissing = (typeof rule.onMissing === "string") ? rule.onMissing : "pass";
        var ctx = mergeContext(getRuleBaseContext(rule), {
            path: pathsText,
            paths: pathsText,
            reason: "missing"
        });

        if (onMissing === "fail") {
            addUnique(allErrors, resolveMissingMessage(rule, "Missing path(s): " + pathsText, ctx));
        } else if (onMissing === "warn") {
            addUnique(allWarnings, resolveWarningMessage(rule, "Missing path(s) (warn): " + pathsText, ctx));
        }
    }

    /**
     * Evaluates all resolved values against one rule, including anyMatch/noneMatch.
     *
     * @param {Object} rule
     * @param {Array<*>} values
     * @param {string} labelForMissing
     * @returns {void}
     */
    function evalValuesAgainstRule(rule, values, labelForMissing) {
        if (!values || values.length === 0) {
            addMissing(rule, labelForMissing);
            return;
        }

        var anyMatch = rule.anyMatch === true;
        var noneMatch = rule.noneMatch === true;

        var validCount = 0;
        var invalidErrors = [];

        // A rule may resolve to many values through wildcards or multiple paths.
        for (var i = 0; i < values.length; i++) {
            var coerced = coerceValueByType(values[i], rule);
            var res = validateValueByType(coerced, rule);

            if (res.valid) {
                validCount++;
                if (noneMatch) break;
            } else {
                if (res.error) invalidErrors.push(res.error);
            }
        }

        if (noneMatch) {
            if (validCount > 0) {
                addRuleError(rule, "A value matched but none were expected to", {
                    values: values,
                    path: labelForMissing,
                    paths: labelForMissing,
                    reason: "noneMatch"
                });
            }
            return;
        }

        if (anyMatch) {
            if (validCount === 0) {
                addRuleError(rule, invalidErrors[0] || "No value matched but at least one was expected to", {
                    values: values,
                    path: labelForMissing,
                    paths: labelForMissing,
                    reason: "anyMatch"
                });
            }
            return;
        }

        for (var e = 0; e < invalidErrors.length; e++) {
            addUnique(allErrors, invalidErrors[e]);
        }
    }

    for (var r = 0; r < rules.length; r++) {
        var rule = rules[r];
        var strict = rule.strictPath === true;

        // Object rules compare selected userDTO values against backendDTO values.
        if (rule && rule.type === "object") {
            try {
                var objRes = validateObjectPair(rule, userDTO, backendDTO);
                if (!objRes || objRes.valid !== true) {
                    addRuleError(rule, (objRes && objRes.error) || "Object compare failed", {
                        reason: "objectCompare"
                    });
                }
            } catch (eObj) {
                addRuleError(rule, eObj.message, {
                    error: eObj,
                    reason: "objectCompareException"
                });
            }
            continue;
        }

        // Joined paths are resolved together, for example portStart + portEnd.
        if (rule.join && Array.isArray(rule.path)) {
            var joinedValues = [];
            try {
                joinedValues = resolveJoinedValue(userDTO, rule.path, rule.join);
            } catch (eJoin) {
                addRuleError(rule, eJoin.message, {
                    error: eJoin,
                    path: rule.path,
                    paths: rule.path,
                    reason: "joinResolveException"
                });
                continue;
            }

            evalValuesAgainstRule(rule, joinedValues, rule.path.join(", "));
            continue;
        }

        // Multiple paths without join are flattened and evaluated as one value set.
        if (Array.isArray(rule.path)) {
            var flat = [];
            var hadAny = false;

            for (var p = 0; p < rule.path.length; p++) {
                var onePath = rule.path[p];
                var resolved = [];

                try {
                    resolved = resolvePath(userDTO, onePath, { strictPath: strict });
                } catch (ePath) {
                    addRuleError(rule, ePath.message, {
                        error: ePath,
                        path: onePath,
                        paths: rule.path,
                        reason: "pathResolveException"
                    });
                    continue;
                }

                if (resolved && resolved.length > 0) hadAny = true;
                for (var x = 0; x < resolved.length; x++) flat.push(resolved[x]);
            }

            if (!hadAny) {
                addMissing(rule, rule.path.join(", "));
                continue;
            }

            evalValuesAgainstRule(rule, flat, rule.path.join(", "));
            continue;
        }

        var values = [];
        try {
            values = resolvePath(userDTO, rule.path, { strictPath: strict });
        } catch (eSingle) {
            addRuleError(rule, eSingle.message, {
                error: eSingle,
                path: rule.path,
                reason: "pathResolveException"
            });
            continue;
        }

        evalValuesAgainstRule(rule, values, String(rule.path));
    }

    return {
        valid: allErrors.length === 0,
        errors: allErrors,
        warnings: allWarnings
    };
}

// ============================================================================
// Single Entry Point: validate(policyArray, userDTO, backendDTO)
// ============================================================================

/**
 * Validates the quality of a policy rule.
 *
 * errorMessage and missingMessage may be strings or functions(ctx).
 *
 * @param {Object} rule
 * @throws {Error}
 */
function assertRuleQuality(rule) {
    if (!rule) throw new Error("Policy rule is null/undefined");

    if (rule.errorMessage !== undefined &&
        typeof rule.errorMessage !== "string" &&
        typeof rule.errorMessage !== "function") {
        throw new Error("Policy rule.errorMessage must be a string or a function");
    }

    if (rule.missingMessage !== undefined &&
        typeof rule.missingMessage !== "string" &&
        typeof rule.missingMessage !== "function") {
        throw new Error("Policy rule.missingMessage must be a string or a function");
    }

    if (rule.warningMessage !== undefined &&
        typeof rule.warningMessage !== "string" &&
        typeof rule.warningMessage !== "function") {
        throw new Error("Policy rule.warningMessage must be a string or a function");
    }

    if (rule.type === "object") {
        var lpOk = (typeof rule.leftPath === "string") || Array.isArray(rule.leftPath);
        var rpOk = (typeof rule.rightPath === "string") || Array.isArray(rule.rightPath);

        if (!lpOk || !rpOk) {
            throw new Error("Policy rule.type:'object' requires leftPath and rightPath (string or array of strings)");
        }

        if (Array.isArray(rule.leftPath) !== Array.isArray(rule.rightPath)) {
            throw new Error("Policy rule.type:'object': leftPath and rightPath must both be arrays or both be strings");
        }

        if (Array.isArray(rule.leftPath) && rule.leftPath.length !== rule.rightPath.length) {
            throw new Error("Policy rule.type:'object': leftPath and rightPath arrays must have equal length");
        }

        if (rule.anyMatch === true && rule.noneMatch === true) {
            throw new Error("Policy rule.anyMatch and rule.noneMatch cannot both be true");
        }

        if (rule.join) {
            throw new Error("Policy rule.type:'object' does not support join");
        }

        return;
    }

    var isArrayPath = Array.isArray(rule.path);
    var isStringPath = (typeof rule.path === "string");

    if (!isArrayPath && !isStringPath) {
        throw new Error("Policy rule.path must be a string or an array of strings");
    }

    if (rule.join && !isArrayPath) {
        throw new Error("Policy rule.join is only allowed when rule.path is an array");
    }

    if (rule.anyMatch === true && rule.noneMatch === true) {
        throw new Error("Policy rule.anyMatch and rule.noneMatch cannot both be true");
    }
}

/**
 * Validates a userDTO against a policy, and optionally validates selected parts
 * against backendDTO using object-compare rules (type:"object").
 *
 * Policy messages:
 * - errorMessage may be a string or a function(ctx)
 * - missingMessage may be a string or a function(ctx)
 *
 * @param {Array<Object>} policy
 * @param {Object} userDTO
 * @param {Object} backendDTO
 * @returns {{valid:boolean, errors:Array<string>, warnings:Array<string>}}
 * @throws {Error}
 */
function validate(policy, userDTO, backendDTO) {
    if (!Array.isArray(policy)) {
        throw new Error("Policy must be an array of rules");
    }

    for (var i = 0; i < policy.length; i++) {
        assertRuleQuality(policy[i]);
    }

    return validateDtoMulti(userDTO, backendDTO, policy);
}
