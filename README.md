# monkeyc-optimizer README

This module is a set of utilities for optimizing Garmin Monkey-C code. Its the engine behind [prettier-extension-monkeyc](https://marketplace.visualstudio.com/items?itemName=markw65.prettier-extension-monkeyc). Its not currently expected to be useful outside of that context but may be extended in future to make it useful in complex projects beyond the scope of that extension.

## Release Notes

#### 1.0.0

Initial release

#### 1.0.1

- Make a better attempt to fix all the negative constants in api.mir
- Make export explicitly do a release build by default.

#### 1.0.2

- Better error reporting when something goes wrong internally
- Fix an order dependency when processing imports. Previously, if the import statement was seen before the module being imported, we would fail to properly handle the import.

### 1.0.3

- Split the build into release and debug, so we can exclude code based on (:release) and (:debug)
- Optimize away `if (constant)`, `while (false)` and `constant ? E1 : E2`. Convert `do BODY while(false)` to `BODY`

### 1.0.4

- Fix a bug resulting in a failure to fully optimize constants initialized by constant conditional expressions
- Make the generated .cjs files work better with es modules (vscode doesn't work with es modules, so prettier-extension-monkeyc doesn't care - but for other projects importing this package it improves the behavior)
- Generate separate debug/release jungle files.

### 1.0.5

- Bump to version 1.0.11 of `@markw65/prettier-plugin-monkeyc` to fix an ObjectLiteral parsing issue.

### 1.0.6

- Bump to version 1.0.12 of `@markw65/prettier-plugin-monkeyc` to fix multiple parser bugs
- Add lots of open source projects as tests. For now, just verify that optimizing the sources succeeds, not that the generated source is actually correct.

### 1.0.7

More fixes found via open source projects.

- Fix parsing of quoted strings in jungle files
- Better error messages from the test framework
- Lazier handling of variables in jungle files
- Fix handling of negative enums that get completely removed
- Fix a bug analyzing empty classes
- Fix a typo that could result in consts being incorrectly eliminated
- Fix an edge case handling local jungle variables
- More test options, and add filters for some of the remote projects
- Try to clean up broken jungles and manifests
- Fix handling of unnamed callees
- Drop unrecognized devices
- Add support for a 'pick-one' device to aid testing
- Add a flag to remote projects to prevent trying to build them (some projects are broken to start with)

### 1.0.8

- Improvements

  - Update to @markw65/prettier-plugin-monkeyc:1.0.14
  - Parse and respect \<build\> instructions in resource files
  - Add minimal barrel support
  - Better checking for whether the optimized source is up to date
  - Rename locals which would be marked re-declaring

- Bug Fixes

  - Generate the default jungle dynamically, since sdk/bin/default.jungle is generated lazily, and may not exist in newly installed sdks, or may be out of date after device installations.
  - Fix a bug generating language settings in optimized jungle
  - Fix a bug introduced by pick-one: don't modify a shared array
  - Don't allow src paths to navigate out of the optimized directory
  - Fix some windows paths issues

- Tests
  - More parallelism while fetching remote projects for testing
  - Add option to build the original project, rather than the optimized one
  - Add support for overriding build options on a per project basis
  - Add an option so we only 'fix' the manifest when running remote projects
  - Check the manifest's application id, and throw in a valid one if necessary
  - Allow project specific overrides for the generated monkey.jungle files, and use it to fix some projects
  - Add patches for some broken projects

### 1.0.9

- Only generate the parts of the jungle we're going to use
- Also publish sdk-util.cjs
- Bump to @markw65/prettier-plugin-monkeyc:1.0.15
  - Fixes a bug that dropped attributes on modules
- LiteralIntegerRe should be case insensitive
- Proper fix for promiseAll
- Auto-include barrels.jungle when its present

### 1.0.10

- Add --execute option to test.js to run the projects after building them
- Add support for optimizing barrels
- Add some typing via jsdoc, and turn on ts validation in vscode
- Bump to @markw65/prettier-plugin-monkeyc:1.0.16 so ts recognizes its exports
- Add [garmin/connectiq-apps](https://github.com/garmin/connectiq-apps) and fix some minor issues it revealed

### 1.0.11

- Improvements

  - Add option to run tests (for projects that have them)
  - Add getProjectAnalysis api, to support various language features in @markw65/prettier-extension-monkeyc

- Bug fixes

  - Fix lookup of self/me

- Code cleanup
  - More typing. Check that build options match previous ones before re-using the optimized files
  - Move everything over to typescript
    - The project was becoming hard to maintain due to too much ad-hoc dynamic typing. This should allow easier/safer refactors and code cleanup.
  - Refactoring to make analysis available in prettier-extension-monkeyc
  - Generate .d.ts, and drop unneeded paths/resolve.alias
  - Pull in a typed version of @markw65/prettier-plugin-monkeyc

### 1.0.12

- Fix connectiq and vscode paths on linux, and better error reporting when they're missing

### 1.0.13

- Improvements

  - Add displayName to deviceInfo (for getTargetDevices in prettier-extenion-monkeyc)
  - Throw a better error when we fail to read a jungle file
  - Don't try to optimize barrel projects

- Code cleanup

  - Update to @markw65/prettier-plugin-monkeyc@1.0.20 for mctree fixes
  - Enable typescript strict checks
  - Turn off synthetic default imports, and fix issues
  - Better manifest typing

- Tests
  - Add date/time to test logging

### 1.0.14

- Bug fixes

  - When reading a barrel project with no products, add all products by default
  - Only set language specific paths for languages that are supported by the device
  - Remove comments that are completely contained within removed nodes

- Code cleanup
  - Upgrade to @markw65/prettier-plugin-monkeyc@1.0.21 for some typescript fixes
  - npm upgrade to pickup ts 4.7.2
  - Add types to package exports for ts 4.7.2
  - Better handling of program-logic errors

### 1.0.15

- Bug fixes
  - Inject the superclass name into the classes namespace
  - Separate type vs value lookup, and use the correct one based on context.

### 1.0.16

- Bug fixes

  - Fix off-by-one in removeNodeComments
  - Fix lookup to consistently lookup types or values.
  - Fix lookup of superclass names

- New Features

  - Add a simple inliner
  - Add support for conditional inlining based on excludeAnnotations

- Testing
  - Add support for @match pragmas to check the optimization results
  - Add a test project, with some inlining tests

### 1.0.17

- New Features

  - Extend the inliner to support more complex functions when called in a void context
  - Cleanup unused expressions. `0;x;foo.bar;a+b` will all now be optimized away.

- Testing

  - Rewrite the @match pragma implementation to have access to the next Node in the ast, rather than just the text of the remainder of the line.
  - Add tests for the statement inliner, and the unused expression cleanup code.

- Bug Fixes
  - Fix a bug affecting lookup of types, which could cause definitions, references and links to the api docs to be missed in the vscode extension

### 1.0.18

- Bug Fixes
  - The new inliner was too agressive at constant propagating literal parameters to their point of use.

### 1.0.19

- Upgrade to @markw65/prettier-plugin-monkeyc@1.0.22

  - fixes some minor typing issues for mctree
  - special handling for certain parenthesized expressions.

- Optimizer

  - Handle more unused expressions, add tests, and prettify the OptimizerTests project
  - Allow statement-style inlining in assignent and return contexts
  - Add diagnostics for failure to inline

- Tests

  - More tweaks to pragma-checker
  - Add launch and task configs for building/running tests

- Code cleanup
  - Properly type the results of JSON.parse
  - Switch over to using ParenthesizedExpression for formatAst (depends on @markw65/prettier-plugin-monkeyc@1.0.22)
