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

### 1.0.20

- Bug fixes

  - Fix a bug marking unknown callees
  - Fix a bug in test.js that didn't notice when tests failed, and fix a failing test

- Optimizer enhancements

  - Re-run the main optimization step, to properly account for functions that are unused after optimization
  - Call the optimizer on 'unused' nodes before returning them

- Code cleanup
  - Called function cleanup

### 1.0.21

- Bug fixes

  - Parameters from the calling function should be treated just line locals when inlining
  - Upgrade to @markw65/prettier-plugin-monkeyc@1.0.24
    - fixes crash with comments following an attribute: `(:foo) /* comment */ function foo() {}`
  - Fix issues with recursive inlining

### 1.0.22

- Improvements

  - Major rewrite of the symbol lookup mechanism, to match monkeyc as closely as possible

    - Fix callee lookup to skip local variables
    - Fix class lookup to first check all the super classes, then to check the context of each super class
    - Fix module lookup to check both the module, and the context of the module
    - Inject class and module names into themselves. So that Graphics.Graphics.COLOR_RED works.

  - Add live diagnostics for missing symbols

- Bug fixes

  - Recognize the the variable in a catch clause is a declaration

- Breaking change
  - By popular demand, reversed the sense of `inline*foo`, so now it inlines when foo is _not_ declared as an excludeAnnotation

### 1.0.23

- Bug Fixes

  - Don't treat parameters to Method types as undeclared variables
    - eg `var x as (Method(a as Number, b as Number) as Void)` should not report that `a` and `b` are undeclared

- Tests
  - Various new tests for module/class/local resolution of symbols
  - Make tests fail by default if the optimizer reports any undefined symbols, and add `@expects` or `checkInvalidSymbols=WARNING` as needed to prevent test failures.

### 1.0.24

- Bug fix
  - The new ast.ts didn't pick up child elements that could be either a string or a node. This resulted in it missing the name in TypeSpecPart.

### 1.0.25

- Bug fix
  - estree-types was missing the returnType on FunctionDeclaration. Update to latest prettier-plugin, and fix ast.ts.

### 1.0.26

- Bug fixes
  - Use `self.` rather than `ClassName.` to qualify names that would otherwise collide with locals, since that works with both public and private variables
  - Fix a bug that caused the inliner to fail to qualify certain names, even if there was a collision with an existing local variables
  - Fix some name lookup issues relating to whether the lookup is done as a type or a value.

### 1.0.27

- Bug fixes
  - Update to `@markw65/prettier-plugin-monkeyc@1.0.29` to fix certain obscure comment related bugs
  - When replacing a node (espcially when inlining), delete any comments contained in the old node.

### 1.0.28

- Bug fixes
  - In some circumstances, while inlining, a parameter could be substituted, and then reprocessed. During reprocessing, it would attempt to lookup the replacement symbol, and if that was a local from the calling function it would fail (since an inline function never has access to the caller's locals). Prevent the reprocessing step from happening.

### 1.0.29

- Update to @markw65/prettier-plugin-monkeyc@1.0.32

  - Fixes a parser issue where `x as Type ? a : b` would be parsed as `(x as Type?) a : b` which would then be reported as a syntax error.

- Bug fixes

  - Fix a bug causing literal nodes to be shared. This was harmless prior to the implementation of the PRE pass

- Code cleanup

  - Add `isStatement` and `isExpression` helpers

- New features

  - Add constant folding for relational and logical operators
  - Allow assignment-scope inlining in variable initializers
  - Better cleanup of unused expressions
  - Add a size based PRE pass. Currently limited to non-local variables, and literals

- Testing
  - Ignore case of typeCheckLevel option
  - Actually run the rest of the expected-to-crash tests
  - Better error messages from pragma checker
  - Better regex for filtering projects

### 1.0.30

- Less greedy approach to finding candidate sets
  - slightly better size reduction when globals maybe modified
- Fix the control flow after the test of a while loop
  - one of the edges was in the wrong place, leading to suboptimal solutions in some cases

Bug Fixes

- Fix a bug that could lead to the optimizer never completing
- Fix a bug that prevented inlining functions that ended in a BlockStatement
- Fix a bug that could cause nested inlined functions inlined in declarations to not be removed

### 1.0.31

- Bug fixes

  - Use withLocDeep on inline results
  - Better tracking of state.inType
  - Fix typo setting up the ProgramState
  - Fix a glitch with the scope of for-statement variable declarations
  - Fix some edge cases with pre
  - Remove a check that crippled pre for literals
    - I had forgotten to remove some code that I added to debug a problem

- Code cleanup

  - Move all the global types to optimizer-types.ts, and explicitly import them
  - Be more consistent about when assignment/update lhs is traversed
  - Rework exposed flag
    - Now it only holds the names of symbols (ie `:name`)
    - There's a separate list of variables that shouldn't be removed
    - There's a separate list of functions that shouldn't be removed
  - Update to [@markw65/prettier-plugin-monkeyc@1.0.33](https://github.com/markw65/prettier-plugin-monkeyc#1033)
  - Update for BigInt literals, and cleanup folding code

- New features

  - Support `obj[:key]` as alternate for obj.key in lookup
    - `Find References`, and `Rename` will recognize these references now.
  - Add an unused variable cleanup pass
    - This will delete variables that are completely unreferenced.

- Analysis/Optimization
  - Collect info about what each function may modify and call
  - Better analysis of inline function bodies
  - Update the StateNodeDecls when renaming locals

### 1.0.32

- Bug fixes
  - Fixup the tests to run unoptimized again, and add running unoptimized to the standard test run
  - Fix PRE to not merge Numbers and Floats (ie 1 is not the same thing as 1.0), and add a test

### 1.0.33

- New features

  - Tagging a function with (:keep) will prevent the optimizer from removing it, even if it appears to be unused.

- Bug fixes
  - Fix PRE to not merge values with different types. ie Number, Long, Float and Double literals should all be treated separately, even when the compare the same.

### 1.0.34

- Bug fixes

  - Fix parser to allow white space to separate attributes, in addition to comma
  - Fix optimizer to respect prettier options when formatting the optimized code

- Testing
  - rewrite test harness in typescript
  - fix up tests to work with compiler2 again, and also with compiler2 at -O0

### 1.0.35

- Testing

  - Add a new open source project
  - Fixup tests to work with compiler2beta2

- Bug fixes
  - Fixed a bug that caused the optimizer to fail if a top level variable declared in a case statement had an initializer with side effects. This didn't produce incorrect results, the optimizer simply bailed out with an obscure error, and refused to optimize the project.

### 1.0.36

- Update to [@markw65/prettier-plugin-monkeyc@1.0.35](https://github.com/markw65/prettier-plugin-monkeyc#1035).
  - Fixes [prettier-plugin-monkeyc#1](https://github.com/markw65/prettier-plugin-monkeyc/issues/1)
  - Fixes [monkeyc-optimizer#1](https://github.com/markw65/monkeyc-optimizer/issues/1)

### 1.0.37

- Update the testing framework to launch the simulator before each test run, rather than start it once at the beginning. This is because the latest beta crashes after successfully completing.
- Update launchSimulator to check if the simulator is already running. This avoids lots of screen switching when the simulator is running on a separate desktop.
- Add optimizerVersion and extensionVersion to build-info.json.

### 1.0.38

- Allow inlining the argument to an if-statement, with the same constraints as inlining in assignment context
- Expand `assignment`, `declaration` and `if` contexts to include (recursively) the left operand of any binary operator, the operand of any unary operator, the `test` operand of any conditional operator or the `object` of a member-expression. So now it will inline `inlinableFunction` in:
  - `var x = !((inlinableFunction() + 4) == 42 ? foo() : bar());`

### 1.0.39

- Improvements

  - Upgrade to [@markw65/prettier-plugin-monkeyc@1.0.36](https://github.com/markw65/prettier-plugin-monkeyc#1036).
  - Upgrade all other npm dependencies to the latest versions, and fix a few issues that showed up as a result.
  - Report missing symbols after optimization, rather than before. Results in fewer false negatives. eg Given `if (foo has :bar) { return foo.bar; }`, where the compiler knows that foo.bar doesn't exist, the whole thing will be optimized away, rather than generate a diagnostic that foo.bar doesn't exist.
  - Stop reporting `X has :Y` as a missing symbol, even when we know that X does not have Y.
  - Implement our own xml parser. This was prompted by wanting to tag the parsed xml with source locations.
  - Since we were already parsing all the resource files to look for `<build>` instructions, additionally identify all the symbols that will get generated. This allows us to detect references to undefined resources, and also makes `Goto Definition` just work for things like `Rez.Strings.foo`.

- Optimizations

  - Optimize has expressions that are guaranteed to be false.

- Bugs

  - Fix an issue with launchSimulator, which caused it to sometimes not bring the simulator window into focus when it should have done.
  - Fix an issue that caused simulateProgram to fail on windows.
  - Fix a bug looking up self when not part of a member-expression (this didn't happen until I added optimizations for "has" expressions, in this release)
  - Add barrel sources to project analysis. This didn't affect optimization, which already included the sources, but did affect `Goto Definition` etc in the vscode extension, and caused lots of diagnostics about missing symbols.
  - ciq-3.2.0 and later devices don't declare "widget" as a supported type, but the compiler does allow you to compile widget projects for them anyway. Fix that when determining the allowable devices in the manifest.
  - Don't drop the `x` in `var x = new X();` even if `x` isn't used, because the monkeyc compiler doesn't generate any code for a bare `new X();`.

- Tests
  - Better error reporting in the driver script.
  - Handle relative jungle paths correctly.
  - Add more tests for strange monkeyc behavior, pre and post compiler2
  - Better identification of compilers that support compiler2

### 1.0.40

- Improvements

  - Upgrade to [@markw65/prettier-plugin-monkeyc@1.0.37](https://github.com/markw65/prettier-plugin-monkeyc#1037).
  - Report locations of errors in manifest.xml (rather than just reporting an error somewhere in the file)
  - Minor improvements to Goto References etc
  - Keep a cache of parsed resource files, and update errors/warnings relating to resources as you type, rather than when the resource file is saved.
  - Add diagnostics for known issues in sdk-4.1.6
  - Add diagnostics for changes in behavior between compiler1 and compiler2
  - Fix lookups to be aware of compiler1 vs compiler2. Add an option to always use compiler1 rules, or always use compiler2 rules.
  - Fix lookups in static methods, under a new option that defaults to true.

- Testing

  - Fix pragma checker to sort the diagnostics properly
  - Allow specifying which test to run on the command line
  - Update all tests to work with 4.1.6 and 4.1.7

- Bug fixes
  - Fix optimization of `and` and `or` (alternate names for `&&` and `||`)
  - Fix a bug that could sometimes prevent the `has` optimization from kicking in.

### 1.0.41

- Bug fixes
  - The fix to avoid visiting definitions from visitReferences was incomplete

### 1.0.42

- Update to [@markw65/prettier-plugin-monkeyc@1.0.38](https://github.com/markw65/prettier-plugin-monkeyc#1038)

  - faster parsing
  - supports parsing the attributes in api.mir, including sdk version etc.

- Performance

  - Using the updated prettier-plugin-monkeyc halves the time spent in the parser
  - There was some pathalogical behavior in the jungle processing. For most projects, it was quite fast (under 1s), but the worst project I found took nearly 5 minutes. I fixed a lot of redundant processing, which dropped most projects to under 500ms, with a worst case of 20s.
  - I had some caching code to prevent reading the same resource file multiple times, but the cache didn't work properly because an async function ran in between the test of the cache, and the fill of the cache; which meant that lots of threads could test the cache and decide it needed to be filled. Fixed by caching Promises, rather than the promise results. Dropped the worst case 20s down to under 500ms, and the average down below 100ms.
  - improved incremental builds (which helps with prettier-extension-monkeyc's live analysis)

- New features
  - Resource files, and manifest.xml generate definitions and references so that prettier-extension-monkeyc can provide Goto Ref/Def between monkeyc, resource, and manifest files.

### 1.0.43

- Update to [@markw65/prettier-plugin-monkeyc@1.0.39](https://github.com/markw65/prettier-plugin-monkeyc#1039)

  - Fixes issues parsing/printing/optimizing NaN

- Fix issues with windows paths introduced in 1.0.42
- Add Symbols (`:name`) to the list of things the inliner knows are constants
- Propagate `:typecheck(false)` to the caller when inlining
- Fix an issue with bogus undefined symbols being reported against manifest.xml in some projects that use barrels.

### 1.0.44

- Update to [@markw65/prettier-plugin-monkeyc@1.0.40](https://github.com/markw65/prettier-plugin-monkeyc#1040)

  - Fixes location ranges associated with parenthesized expressions
  - Fixes parsing of Lang.Char literals

- Add more parsing of expressions embedded in resource files. This should now be complete, in that the analasis pass should see every symbol definition and reference from anywhere in the project.
- Generalize constant folding to (nearly) all supported types. We don't fold additions between Float or Double and String, because the exact behavior is [buggy and upredictable](https://forums.garmin.com/developer/connect-iq/i/bug-reports/sdk-4-1-7-constant-folds-floats-strings-incorrectly)

### 1.0.45

- Update to [@markw65/prettier-plugin-monkeyc@1.0.41](https://github.com/markw65/prettier-plugin-monkeyc#1041)

  - Fixes a few parser edge cases

- Bug fixes

  - Fix a bug constant folding == and !=
  - Make sure to include all languages, even for devices that don't support them, because they're still supported in settings. Do this in a way that avoids creating warnings.
  - Look at all build dependencies when deciding whether to regenerate the optimized files.
  - Don't produce errors when "-" is used as the first character of an id in a resource file (although in most cases, this is not a good idea, and will fail at compile time)

- Improvements
  - Better typing for resources
  - Refactor PRE
  - Improve accuracy of whether or not a function can modify a particular global (resulting in better PRE)

### 1.1.0

- Implements a type analyzer, to enable better optimizations

  - adds options `trustDeclaredTypes` and `propagateTypes`. See https://github.com/markw65/monkeyc-optimizer/wiki/Type-and-Dataflow-analysis

- Improved optimizations

  - SizeBasedPRE now has finer granularity, making it generally find more opportunities
  - Lots of improvements to binary operators, and folding. Subject to suitable type checks,
    - `(x + K1) + K2` => `x + (K1 + K2)`
    - `(x + K1) + (y + K2)` => `(x + y) + (K1 + K2)`
    - `(x + K1) + y` => `(x + y) + K1`, so that `((x + K1) + y) + K2` => `(x + y) + (K1 + K2)`
    - `(x + -y)` and `(-y + x)` => `x - y`
    - `x + 0` => `x`
    - `x * 0` => `0`
  - Various boolean optimizations:
    - `!x ? y : z` => `x ? z : y`
    - `x ? true : false` => `x`
    - `x ? false : true` => `!x`
    - `x && true` => `x`, `y || false` => `y`
  - constant propagation
    - `var x = 42; ...; foo(x)` => `...; foo(42)`

- Bug fixes
  - Fixes a bug that could ignore side effects from Method.invoke
  - Fixes a crash in the inliner, when trying to inline a function with multiple returns

### 1.1.1

- Fix the package spec to include the new .d.ts files

### 1.1.2

- Fix a couple of edge cases when constant folding == and !=
- Optimize `<boolean> && false`, and `<boolean> || true`, when `<boolean>` has no side effects
- Better optimization of inlined function bodies
- Analyze constants with casts to help with constant propagation
- Ignore widening casts (eg a cast that is given a `Number` and converts it to `Number or String`)
- More accurate deletion of unused constants. Sometimes a constant that was unused after the optimization phase ended, was still considered used because of references that were eventually deleted.
