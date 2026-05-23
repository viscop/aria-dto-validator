# Tests

These tests are optional and are not required to use the DTO Validator in Aria Automation or Aria Orchestrator.

The validator itself has no Node.js dependency. The local test runner only uses Node.js so developers can execute the same validation cases quickly from VSCode or a terminal.

## Run Locally

From the repository root:

```powershell
node tests/run-tests.js
```

The runner loads `validateDto.js` or `validateDto`, wraps it like an Aria/vRO Action, and executes every JSON file in `tests/cases`.

## Run From VSCode

Use the included VSCode task:

```text
Terminal -> Run Task -> Run DTO Validator Tests
```

or run the same command directly in the integrated terminal:

```powershell
node tests/run-tests.js
```

## Test Case Format

Each test case is a plain JSON document:

```json
{
  "name": "basic valid request",
  "userDTO": {},
  "backendDTO": {},
  "policy": [],
  "expected": {
    "valid": true
  }
}
```

JSON policies stored as strings can be tested with `policyJson`. The runner parses `policyJson` before calling the validator, which mirrors how a workflow would parse a policy loaded from an Aria Configuration Element.

## Aria Orchestrator Usage

The files in `tests/cases` are intentionally plain JSON. Aria developers can copy the `userDTO`, `backendDTO`, and `policy` values into a Scriptable Task or Action test workflow and call `validateDto` directly.
