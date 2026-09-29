# Aria DTO Validator

A JavaScript validator for VMware Aria Automation / Aria Orchestrator that validates DTOs against business policies.

The DTO Validator is designed to simplify input validation for Aria Automation forms, form actions, and Aria Orchestrator workflows. It lets validation rules be expressed as declarative policies and reused wherever the same request data must be checked.

When an Aria Automation catalog item, Day 2 action, or resource action is submitted through the regular request process, the configured validation action is executed as part of the form behavior. When the same workflow is invoked through the REST API, that form-level validation path is not involved. In that case, validation must be implemented inside the workflow before the data is trusted or processed.

The DTO Validator supports both use cases with the same policy format: use it in form actions for immediate feedback during catalog use, and reuse the same policy in workflows that can also be started through API automation.

The validator also performs explicit type handling based on the policy. For example, values supplied as strings by form inputs can be validated as `number` or integer-like values in the policy, which reduces boilerplate conversion logic in form actions and workflows.

## Related article

I wrote a introduction to the idea behind this project here:

[Policy-Based Input Validation in VMware Aria Orchestrator](https://www.visualdomain.ch/?p=112)

The article explains the motivation behind the validator, shows why UI validation alone is not enough, and includes practical examples for integrating the framework into VMware Aria Automation custom form actions and Aria Orchestrator workflows.

## Table of Contents

- [Usage in Aria Automation](#usage-in-aria-automation)
- [Policy Format](#policy-format)
- [Quick Start](#quick-start)
- [Path Syntax](#path-syntax)
- [Rule Structure](#rule-structure)
- [Fail-Fast Validation](#fail-fast-validation)
- [String Rules](#string-rules)
- [Number Rules](#number-rules)
- [Boolean Rules](#boolean-rules)
- [Date Rules](#date-rules)
- [Object Comparison with backendDTO](#object-comparison-with-backenddto)
- [Missing Values](#missing-values)
- [Custom Messages](#custom-messages)
- [Context Codes](#context-codes)
- [Reusable Policy Building Blocks](#reusable-policy-building-blocks)
- [Complete Workflow Example](#complete-workflow-example)
- [Developer Notes](#developer-notes)
- [Design Choice: Single Action](#design-choice-single-action)
- [Testing](#testing)
- [AI Disclosure](#ai-disclosure)
- [License](#license)

## Usage in Aria Automation

The `validateDto` script can be used as an Aria/vRO Action. It expects these variables:

| Name         | Type   | Description                                                                                                         |
| ------------ | ------ | ------------------------------------------------------------------------------------------------------------------- |
| `policy`     | Array  | List of validation rules.                                                                                           |
| `userDTO`    | Object | The input/request data to validate. Despite the name, this does not have to be a user object.                       |
| `backendDTO` | Object | Optional reference data, such as catalog, API, or backend lookup results. Required only for `type: "object"` rules. |

Return value:

```javascript
{
  valid: true,
  errors: [],
  warnings: []
}
```

If validation fails, `valid` is set to `false` and `errors` contains unique error messages.

`backendDTO` can be `null` or `{}` when the policy only contains primitive validation rules (`string`, `number`, `boolean`, or `date`). It is required only when object comparison rules are used, because `type: "object"` compares values from `userDTO` against reference values from `backendDTO`.

## Policy Format

The validator accepts the policy as a JavaScript array of rule objects. JSON-compatible policies are supported as long as they are passed to `validate(...)` as an already parsed array.

```javascript
var userDTO = {
  environment: actionInput, // value of actionInput e.x = test
};

backendDTO = null; // No validation against the backend

var policyJson =
  '[{"path":"environment","type":"string","allowedValues":["dev","test","prod"]}]';
var policy = JSON.parse(policyJson);

var result = System.getModule("ch.org.security.validation").validateDto(
  policy,
  userDTO,
  backendDTO,
);
```

A raw JSON string is not parsed automatically by the validator. Passing the string directly would fail because `validate(...)` expects an array:

```javascript
// This is not supported directly:
var result = System.getModule("ch.org.security.validation").validateDto(
  policyJson,
  userDTO,
  backendDTO,
);
```

Pure JSON policies are useful when rules should be stored in configuration, read from external sources, or shared between form actions and workflows. Keep in mind that JSON cannot contain JavaScript functions, so dynamic `errorMessage`, `missingMessage`, or `warningMessage` functions are only available when the policy is built as JavaScript.

The same applies to regular expressions. JSON has no native regular expression type, so JSON-based policies must store regex patterns as strings:

```json
{
  "path": "hostname",
  "type": "string",
  "regex": "^[a-z0-9-]+$"
}
```

When policies are defined as native JavaScript objects, for example in a vRO Action that returns a policy array, regular expression literals can be used directly:

```javascript
var policy = [
  {
    path: "hostname",
    type: "string",
    regex: /^[a-z0-9-]+$/,
  },
];
```

Even when the base policy is stored as static JSON, it can still be adjusted after parsing. This is useful when most rules should come from an Aria Configuration Element, but selected values depend on runtime context such as environment, tenant, project, or catalog item.

```javascript
var policyJson = configurationElement.getAttributeWithKey(
  "dtoValidationPolicy",
).value;
var policy = JSON.parse(policyJson);

var environment = userDTO.request.environment;

for (var i = 0; i < policy.length; i++) {
  if (policy[i].path === "request.size.memoryGb") {
    policy[i].allowedValues =
      environment === "prod" ? [8, 16, 32, 64] : [2, 4, 8, 16];
  }
}

var result = System.getModule("ch.org.security.validation").validateDto(
  policy,
  userDTO,
  backendDTO,
);
```

This pattern keeps the policy centrally configurable while still allowing the workflow or action to apply context-specific validation rules before execution.

## Quick Start

Before using the validator, create an Aria Orchestrator Action named `validateDto`
in the module where you want to publish the framework, for example
`ch.org.security.validation`. Paste the full contents of `validateDto.js` into
that Action and configure the Action inputs as `policy`, `userDTO`, and
`backendDTO`.

```javascript
var userDTO = {
  hostname: "app01",
  cpu: 4,
  environment: "prod",
  ports: [{ from: 443, to: 443 }],
};

var policy = [
  {
    path: "hostname",
    type: "string",
    minLength: 3,
    maxLength: 30,
    regex: "^[a-z0-9-]+$",
    errorMessage: "Hostname is invalid.",
  },
  {
    path: "cpu",
    type: "number",
    integerOnly: true,
    allowedValues: [2, 4, 8],
    errorMessage: "CPU must be 2, 4, or 8.",
  },
  {
    path: "environment",
    type: "string",
    allowedValues: ["dev", "test", "prod"],
    errorMessage: "Environment is not allowed.",
  },
];

var result = System.getModule("ch.org.security.validation").validateDto(
  policy,
  userDTO,
);

if (!result.valid) {
  throw "DTO validation failed: " + result.errors.join("; ");
}
```

The `validateDto` Action body/source file already includes the Action entry point:

```javascript
var result = validate(policy, userDTO, backendDTO);
return result;
```

## Path Syntax

Rules read values from `userDTO` through `path`.

| Syntax         | Example                    | Meaning                                              |
| -------------- | -------------------------- | ---------------------------------------------------- |
| Dot notation   | `vm.name`                  | Read an object property.                             |
| Array index    | `nics[0].network`          | Read a specific array element.                       |
| Wildcard       | `nics[*].network`          | Read all array elements.                             |
| Quoted key     | `customProperties["a.b"]`  | Read property names with special characters or dots. |
| Multiple paths | `["portStart", "portEnd"]` | Evaluate values from several paths together.         |

With `strictPath: true`, array fields must be addressed explicitly with `[n]` or `[*]`. This helps detect ambiguous policies early.

## Rule Structure

```javascript
{
  path: "vm.name",
  type: "string",
  onMissing: "fail",
  errorMessage: "VM name is invalid.",
  missingMessage: "VM name is missing."
}
```

Common options:

| Option           | Description                                                       |
| ---------------- | ----------------------------------------------------------------- |
| `path`           | String or array of strings. Not required for `type: "object"`.    |
| `type`           | `string`, `number`, `boolean`, `date`, or `object`.               |
| `onMissing`      | Behavior when no value is found: `pass` default, `warn`, `fail`.  |
| `anyMatch`       | For multiple resolved values, at least one valid value is enough. |
| `noneMatch`      | No resolved value may satisfy the rule.                           |
| `errorMessage`   | Custom error message as a string or function.                     |
| `missingMessage` | Custom message for missing paths as a string or function.         |
| `warningMessage` | Custom warning message for `onMissing: "warn"`.                   |
| `strictPath`     | Requires explicit array paths.                                    |
| `stopOnFailure`  | Stops policy evaluation when this rule produces an error.          |

`anyMatch` and `noneMatch` cannot be enabled at the same time.

The policy array itself is evaluated as an implicit AND: all rules must pass for `result.valid` to be `true`. If multiple conditions must be satisfied for the same value, add multiple rules for the same `path`.

```javascript
var policy = [
  {
    path: "hostname",
    type: "string",
    minLength: 3,
    errorMessage: "Hostname is too short.",
  },
  {
    path: "hostname",
    type: "string",
    regex: "^[a-z0-9-]+$",
    errorMessage: "Hostname contains invalid characters.",
  },
];
```

## Fail-Fast Validation

Rules are evaluated in policy order. By default, validation continues after a failed rule so that all applicable errors can be returned together.

Set `stopOnFailure: true` on a rule when later rules must only run after that rule succeeds. This is useful for security gates, prerequisite checks, or validations whose later steps assume that the input already has a safe format.

```javascript
var policy = [
  {
    path: "commandParameter",
    type: "string",
    regex: "^(?!-)[A-Za-z0-9._-]+$",
    onMissing: "fail",
    stopOnFailure: true,
    errorMessage: "The command parameter contains unsafe characters.",
  },
  {
    path: "commandParameter",
    type: "string",
    allowedValues: ["start", "stop", "status"],
    onMissing: "fail",
    errorMessage: "The command parameter is not approved.",
  },
];
```

If the regular expression check fails, the `allowedValues` rule is not evaluated. If the first rule succeeds, validation continues with the allowlist check.

`stopOnFailure` applies only to errors produced by the current rule. Warnings do not stop evaluation. If the option is omitted or set to `false`, the existing error-collection behavior is preserved. The validator still checks the structure of the complete policy before evaluating DTO values, so malformed later rules are rejected even when an earlier validation rule would stop evaluation.

## String Rules

```javascript
{
  path: "hostname",
  type: "string",
  trim: true,
  minLength: 3,
  maxLength: 30,
  regex: "^[a-z0-9-]+$",
  ignoreCase: true
}
```

Supported options:

| Option                             | Description                                                 |
| ---------------------------------- | ----------------------------------------------------------- |
| `nullOrEmpty`                      | Allows `null` or empty strings.                             |
| `trim`                             | Removes leading and trailing whitespace before validation.  |
| `minLength`, `maxLength`, `length` | Length checks.                                              |
| `regex`                            | RegExp or regex string.                                     |
| `ignoreCase`                       | Case-insensitive comparisons.                               |
| `eq`, `neq`                        | Exact allowed or forbidden value.                           |
| `startsWith`, `endsWith`           | Prefix or suffix checks.                                    |
| `contains`, `notContains`          | Required or forbidden substring.                            |
| `anyOf`                            | List of alternative conditions, such as `const` or `regex`. |
| `allowedValues`                    | List of allowed strings.                                    |
| `notAllowedValues`                 | List of forbidden strings.                                  |

`allowedValues` and `notAllowedValues` must contain only strings. Both comparisons are case-sensitive by default and respect `ignoreCase: true`.

For example, this rule rejects reserved user names regardless of capitalization:

```javascript
{
  path: "request.userName",
  type: "string",
  notAllowedValues: ["admin", "root", "system"],
  ignoreCase: true,
  errorMessage: "This user name is reserved."
}
```

Example:

```javascript
{
  path: "request.ownerEmail",
  type: "string",
  regex: "^[^@]+@example\\.com$",
  ignoreCase: true,
  onMissing: "fail",
  errorMessage: "Owner email must be an example.com address."
}
```

## Number Rules

```javascript
{
  path: "cpu",
  type: "number",
  integerOnly: true,
  min: 2,
  max: 16
}
```

Supported options:

| Option                   | Description                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `nullOrEmpty`            | Allows `null` or empty values.                                                        |
| `integerOnly`            | Allows integers only.                                                                 |
| `min`, `max`             | Inclusive numeric range.                                                              |
| `between`                | Shortcut for `[min, max]`.                                                            |
| `gt`, `gte`, `lt`, `lte` | Comparison operators.                                                                 |
| `eq`, `neq`              | Must equal or must not equal.                                                         |
| `multipleOf`             | Must be a multiple of the configured value.                                           |
| `allowedValues`          | Allowed numbers or ranges, for example `[22, "80-90", 443]`.                          |
| `notAllowedValues`       | Forbidden numbers or ranges.                                                          |
| `allowRangeInput`        | Allows inputs such as `"4609-4615"` if the range is fully covered by `allowedValues`. |

`notAllowedValues` supports the same number and range notation as `allowedValues`. This is useful for reserved ports or blocked numeric ranges:

```javascript
{
  path: "port",
  type: "number",
  integerOnly: true,
  notAllowedValues: ["20-30", 3389],
  errorMessage: "Port is reserved."
}
```

Port example:

```javascript
{
  path: "firewallRules[*].port",
  type: "number",
  integerOnly: true,
  allowedValues: [22, 80, 443, "8000-8100"],
  errorMessage: "Port is not approved."
}
```

Range inputs can be composed from two fields:

```javascript
{
  path: ["portStart", "portEnd"],
  join: "-",
  type: "number",
  integerOnly: true,
  allowedValues: ["4609-4615", 443],
  errorMessage: "Port range is not allowed."
}
```

Range input is detected automatically when a rule uses `join` and the joined value looks like a numeric range, for example `"4609-4615"`. In that case, `allowRangeInput` is not required.

For a single field that already contains a range string, set `allowRangeInput: true` explicitly. This keeps normal `number` fields strict and avoids accepting accidental range-like input.

`allowRangeInput` changes how number values are interpreted when the resolved value is a range string such as `"4609-4615"`. Instead of validating only a single numeric value, the validator checks whether the full requested range is covered by `allowedValues`.

This is useful for Aria forms where users enter a start and end value, for example firewall port ranges. With `join: "-"`, two fields can be combined into one range string before validation.

Example:

```javascript
var userDTO = {
  portStart: "4609",
  portEnd: "4615",
};

var policy = [
  {
    path: ["portStart", "portEnd"],
    join: "-",
    type: "number",
    integerOnly: true,
    allowedValues: ["4600-4620", 443],
    errorMessage: "Port range is not allowed.",
  },
];
```

In this example, the input becomes `"4609-4615"` and is valid because the entire range is covered by `"4600-4620"`. If the user submits `"4590-4615"`, validation fails because the requested range starts outside the allowed range.

When `allowRangeInput` is used, `allowedValues` is required. Range input cannot be combined with numeric comparison options such as `min`, `max`, `gt`, `lt`, `eq`, `neq`, or `multipleOf`.

Single-field range example:

```javascript
{
  path: "portRange",
  type: "number",
  allowRangeInput: true,
  integerOnly: true,
  allowedValues: ["4600-4620", 443],
  errorMessage: "Port range is not allowed."
}
```

## Boolean Rules

Boolean values can be supplied as `true`/`false`, `"true"`/`"false"`, `"1"`/`"0"`, or `1`/`0`.

```javascript
{
  path: "backup.enabled",
  type: "boolean",
  eq: true,
  errorMessage: "Backup must be enabled."
}
```

Supported options are `eq` and `neq`.

## Date Rules

Date rules accept JavaScript `Date` values or parseable date strings.

```javascript
{
  path: "expiresAt",
  type: "date",
  gte: true,
  referenceDate: "2026-01-01T00:00:00Z",
  errorMessage: "Expiration date must be after the reference date."
}
```

Supported options:

| Option                   | Description                                          |
| ------------------------ | ---------------------------------------------------- |
| `nullOrEmpty`            | Allows `null` or empty values.                       |
| `referenceDate`          | Comparison date. If omitted, `new Date()` is used.   |
| `offset`                 | Expected offset from the reference date in seconds.  |
| `offsetTolerance`        | Tolerance for `offset` in milliseconds.              |
| `eq`, `min`, `max`       | Exact date or boundaries.                            |
| `gt`, `gte`, `lt`, `lte` | Compare against `referenceDate` or the current time. |

Note: `min` and `max` use `System.getDateFromFormat(...)` in the script and are therefore intended for the Aria/vRO runtime.

## Object Comparison with backendDTO

With `type: "object"`, selected parts of `userDTO` are compared against `backendDTO`. This is useful when users may only select values that came from a backend query.

The object comparison is a semantic value comparison, similar in intent to an `equals` implementation in Java. It does not check whether two objects are the same JavaScript instance. Instead, it checks whether the selected DTO structures are equal from a business perspective: the expected keys and values from the user input must be present in the backend data, recursively including nested objects and arrays.

```javascript
var userDTO = {
  networks: [{ name: "prod-net", zone: "eu" }],
};

var backendDTO = {
  allowedNetworks: [
    { name: "prod-net", zone: "eu", id: "net-123" },
    { name: "test-net", zone: "eu", id: "net-456" },
  ],
};

var policy = [
  {
    type: "object",
    leftPath: "networks",
    rightPath: "allowedNetworks",
    objectMode: "subset",
    arrayDefault: {
      quantifier: "all",
      distinct: true,
    },
    errorMessage: "At least one selected network is not allowed.",
  },
];
```

`objectMode`:

| Value       | Behavior                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------- |
| `deepEqual` | Default. Both objects must contain the same keys and values.                             |
| `subset`    | All keys from `userDTO` must exist in the backend value. Extra backend keys are allowed. |

Array options:

| Option               | Description                                                            |
| -------------------- | ---------------------------------------------------------------------- |
| `quantifier: "all"`  | All left-side array elements must be found on the right side. Default. |
| `quantifier: "any"`  | At least one left-side array element must be found on the right side.  |
| `quantifier: "none"` | No left-side array element may be found on the right side.             |
| `distinct: true`     | Deduplicate left-side array elements before comparison.                |

Special rules for nested arrays:

```javascript
{
  type: "object",
  leftPath: "rules",
  rightPath: "allowedRules",
  objectMode: "subset",
  arrayDefault: { quantifier: "all", distinct: true },
  arrayRules: [
    {
      path: "rules[*].ports",
      quantifier: "any",
      distinct: true
    }
  ]
}
```

## Missing Values

By default, a path that does not resolve to any value is not treated as an error. The behavior is controlled with `onMissing`.

```javascript
{
  path: "costCenter",
  type: "string",
  onMissing: "fail",
  missingMessage: "Cost center is missing."
}
```

Possible values:

| Value  | Result                            |
| ------ | --------------------------------- |
| `pass` | No error and no warning. Default. |
| `warn` | Message is added to `warnings`.   |
| `fail` | Message is added to `errors`.     |

## Custom Messages

`errorMessage`, `missingMessage`, and `warningMessage` can be strings or functions.

```javascript
{
  path: "commandParameter",
  type: "string",
  regex: "^(?!-)[A-Za-z0-9._-]+$",
  allowedValues: ["start", "stop", "status"],
  errorMessage: function (ctx) {
    if (ctx.code === "string.regex") {
      return "The command parameter contains unsafe characters.";
    }

    if (ctx.code === "string.allowedValues") {
      return "The command parameter is not approved.";
    }

    return "The command parameter is invalid: " + ctx.reason;
  }
}
```

Depending on the situation, the context contains:

| Field             | Content                                    |
| ----------------- | ------------------------------------------ |
| `rule` / `schema` | The current rule.                          |
| `userDTO`         | The full user DTO.                         |
| `backendDTO`      | The full backend DTO.                      |
| `value`           | The validated value, if available.         |
| `path` / `paths`  | Affected path or path list.                |
| `code`             | Stable, machine-readable validation code.  |
| `reason`          | Technical reason for the validation error. |

Use `ctx.code` when message behavior depends on the failed validation. Codes are part of the public policy interface and are intended for programmatic comparisons. `ctx.reason` is a human-readable technical description and may contain additional details, so it should primarily be used for diagnostics or as a fallback message.

When a rule contains several constraints, they are checked in their documented implementation order and validation returns from that rule after its first failed constraint. For example, a string rule checks `regex` before `allowedValues`. The callback therefore receives `string.regex` when the format is unsafe, or `string.allowedValues` when the format is valid but the value is not in the allowlist.

## Context Codes

Context codes identify why a message callback was invoked. Type-specific codes describe value validation failures. Rule, path, and object codes describe policy-level or resolution failures.

### String Codes

| Code                      | Meaning                                      |
| ------------------------- | -------------------------------------------- |
| `string.empty`            | The value is null or empty.                  |
| `string.type`             | The value is not a string.                   |
| `string.minLength`        | The value is shorter than `minLength`.       |
| `string.maxLength`        | The value is longer than `maxLength`.        |
| `string.length`           | The value does not have the required length. |
| `string.regex`            | The value does not match `regex`.            |
| `string.eq`               | The value does not satisfy `eq`.             |
| `string.neq`              | The value does not satisfy `neq`.            |
| `string.startsWith`       | The value does not have the required prefix. |
| `string.endsWith`         | The value does not have the required suffix. |
| `string.contains`         | A required substring is missing.             |
| `string.notContains`      | A forbidden substring is present.            |
| `string.anyOf`            | No `anyOf` condition matched.                |
| `string.allowedValues`    | The value is not in `allowedValues`.         |
| `string.notAllowedValues` | The value is in `notAllowedValues`.          |

### Number Codes

| Code                                  | Meaning                                                        |
| ------------------------------------- | -------------------------------------------------------------- |
| `number.empty`                        | The value is null or empty.                                    |
| `number.format`                       | The value does not use a supported numeric format.             |
| `number.type`                         | The value cannot be interpreted as a number.                   |
| `number.integerOnly`                  | The value is not an integer.                                   |
| `number.min` / `number.max`           | The value is outside the inclusive minimum or maximum.         |
| `number.gt` / `number.gte`            | The value does not satisfy the configured lower comparison.    |
| `number.lt` / `number.lte`            | The value does not satisfy the configured upper comparison.    |
| `number.eq` / `number.neq`            | The value does not satisfy the equality comparison.            |
| `number.multipleOf`                   | The value is not a multiple of the configured number.          |
| `number.allowedValues`                | The value or range is not covered by `allowedValues`.          |
| `number.allowedValues.invalid`        | `allowedValues` is empty or cannot form valid intervals.       |
| `number.notAllowedValues`             | The value is covered by `notAllowedValues`.                    |
| `number.range.format`                 | A range input has an invalid format.                           |
| `number.range.allowedValuesRequired`  | A range input was used without `allowedValues`.                |
| `number.range.comparisonConflict`     | Range input was combined with an incompatible comparison rule. |

### Boolean and Date Codes

| Code                                      | Meaning                                                |
| ----------------------------------------- | ------------------------------------------------------ |
| `boolean.format`                          | A string or number is not a supported boolean format. |
| `boolean.type`                            | The value is not a boolean after coercion.             |
| `boolean.eq` / `boolean.neq`              | The value does not satisfy the equality comparison.    |
| `date.empty`                              | The date value is null or empty.                       |
| `date.format`                             | A date string cannot be parsed.                        |
| `date.type`                               | The value does not use a supported date type.          |
| `date.offset`                             | The date is outside the allowed offset tolerance.      |
| `date.eq`                                 | The date does not equal the configured date.           |
| `date.min` / `date.max`                   | The date is outside a configured boundary.             |
| `date.max.invalid`                        | The configured maximum date is invalid.                |
| `date.gt` / `date.gte`                    | The date does not satisfy the lower comparison.        |
| `date.lt` / `date.lte`                    | The date does not satisfy the upper comparison.        |

### Rule, Path, and Object Codes

| Code                            | Meaning                                                       |
| ------------------------------- | ------------------------------------------------------------- |
| `path.missing`                  | A configured path did not resolve and `onMissing` handled it. |
| `path.resolve`                  | A normal or multi-path expression could not be resolved.      |
| `path.joinResolve`              | A joined path expression could not be resolved.               |
| `rule.anyMatch`                 | No resolved value satisfied an `anyMatch` rule.               |
| `rule.noneMatch`                | A resolved value satisfied a `noneMatch` rule.                |
| `rule.allowedValues.invalid`    | `allowedValues` has an unsupported shape or entry type.       |
| `rule.notAllowedValues.invalid` | `notAllowedValues` has an unsupported shape or entry type.    |
| `object.compare`                | An object comparison failed.                                  |
| `object.compareException`       | An object comparison raised an exception.                     |

For aggregate rules, the callback receives the aggregate code. For example, a failed `anyMatch` rule reports `rule.anyMatch`, even when the individual values failed because of `string.regex` or `string.allowedValues`. Use separate rules when each underlying constraint needs its own final message.

## Reusable Policy Building Blocks

Policies are plain JavaScript objects. This means you can define shared variables, arrays, and helper functions first, and then assign their results to policy properties such as `allowedValues`. This is useful when the same policy should be used by an Aria Automation form action, and by the executing workflow or action.

```javascript
var allowedEnvironments = ["dev", "test", "prod"];
var allowedCpuSizes = [2, 4, 8];

function getAllowedMemorySizes(environment) {
  if (environment === "prod") {
    return [8, 16, 32, 64];
  }

  if (environment === "test") {
    return [4, 8, 16];
  }

  return [2, 4, 8];
}

var environment = userDTO.request.environment;
var allowedMemorySizes = getAllowedMemorySizes(environment);

var policy = [
  {
    path: "request.environment",
    type: "string",
    allowedValues: allowedEnvironments,
    onMissing: "fail",
    errorMessage: "Environment must be dev, test, or prod.",
  },
  {
    path: "request.size.cpu",
    type: "number",
    integerOnly: true,
    allowedValues: allowedCpuSizes,
    errorMessage: "CPU size is not allowed.",
  },
  {
    path: "request.size.memoryGb",
    type: "number",
    integerOnly: true,
    allowedValues: allowedMemorySizes,
    errorMessage: function (ctx) {
      return (
        "Memory size is not allowed for environment '" +
        environment +
        "': " +
        ctx.value +
        " GB"
      );
    },
  },
];
```

This pattern keeps the policy declarative while still allowing workflow or action specific logic to decide which values are valid for a given request.

## Complete Example

```javascript
var allowedEnvironments = ["dev", "test", "prod"];
var allowedCpuSizes = [2, 4, 8];
var deniedTags = ["forbidden", "internal-only"];

function getMemoryRange(environment) {
  if (environment === "prod") {
    return [8, 64];
  }

  return [4, 32];
}

var memoryRange = getMemoryRange(userDTO.request.environment);

var policy = [
  {
    path: "request.hostname",
    type: "string",
    trim: true,
    regex: "^[a-z][a-z0-9-]{2,29}$",
    onMissing: "fail",
    missingMessage: "Hostname is missing.",
    errorMessage: "Hostname does not match the naming convention.",
  },
  {
    path: "request.environment",
    type: "string",
    allowedValues: allowedEnvironments,
    onMissing: "fail",
    errorMessage: "Environment is not allowed.",
  },
  {
    path: "request.size.cpu",
    type: "number",
    integerOnly: true,
    allowedValues: allowedCpuSizes,
    onMissing: "fail",
    errorMessage: "CPU size is not allowed.",
  },
  {
    path: "request.size.memoryGb",
    type: "number",
    integerOnly: true,
    between: memoryRange,
    errorMessage: function () {
      return (
        "Memory must be between " +
        memoryRange[0] +
        " and " +
        memoryRange[1] +
        " GB for this environment."
      );
    },
  },
  {
    path: "request.tags[*]",
    type: "string",
    noneMatch: true,
    allowedValues: deniedTags,
    errorMessage: "At least one tag is not allowed.",
  },
  {
    type: "object",
    leftPath: "request.networks",
    rightPath: "catalog.allowedNetworks",
    objectMode: "subset",
    errorMessage: "Selected network is not allowed by the catalog.",
  },
];

var result = System.getModule("ch.org.security.validation").validateDto(
  policy,
  userDTO,
  backendDTO,
);

if (!result.valid) {
  throw result.errors.join("; ");
}

return result;
```

## Developer Notes

- Policies are plain JavaScript objects and can be built dynamically inside a action or workflow.
- Policies can be reused across multiple validation calls. The validator works on internal deep clones of rule objects before normalizing fields such as `allowedValues`.
- Error messages are deduplicated. The same error message appears only once.
- Always set `onMissing: "fail"` for required fields.
- Prefer explicit paths for arrays, such as `items[*].name`. With `strictPath: true`, accidentally imprecise paths can be detected early.

## Design Choice: Single Action

The validator is intentionally packaged as a single self-contained Action. While the file is larger than a typical workflow helper script, this keeps deployment, versioning, and reuse simple in Aria Orchestrator environments.

The size comes from centralizing validation behavior, path resolution, type handling, object comparison, and message handling in one dependency-free implementation. Consumers are expected to use the declarative policy interface rather than modifying internal helper functions directly.

Splitting the internal helpers into multiple Actions would make some functions reusable in isolation, but it would also introduce Action dependencies, version coordination, and additional import/export overhead. For this use case, a tested single-Action library is the more portable option.

## Testing

The validator itself has no Node.js dependency. The repository includes an optional dependency-free Node.js test runner so developers can execute validation cases directly from VSCode or a terminal.

```powershell
node tests/run-tests.js
```

In VSCode, use:

```text
Terminal -> Run Task -> Run DTO Validator Tests
```

The test cases in `tests/cases` are plain JSON files. They can also be copied into Aria Orchestrator Scriptable Tasks or test workflows or actions if developers prefer validating behavior directly in the Aria runtime.

## AI Disclosure

The concept, architecture, validation model, expected behavior, API design, and
functional requirements of this project were conceived and defined by the
author for use in VCF Orchestrator.

The implementation and project-specific automated tests were generated
entirely using AI based on these requirements and design decisions.

The generated implementation was validated through automated tests and
functional verification. Selected parts of the source code were also reviewed
by the author. The software is currently in production use.

The documentation was created with AI assistance and reviewed by the author.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.

VMware Aria, VMware Aria Automation, and VMware Aria Orchestrator are trademarks or registered trademarks of their respective owners. This project is not affiliated with, endorsed by, or sponsored by VMware/broadcom.
