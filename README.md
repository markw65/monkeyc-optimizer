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
