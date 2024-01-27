# Change Log

All notable changes to the "monkeyc-optimizer" package will be documented in this file.

### 1.1.40

- Update the bytecode optimizer to be compatible with Sdk-7.x

### 1.1.39

- Update to [@markw65/prettier-plugin-monkeyc@1.0.54](https://github.com/markw65/prettier-plugin-monkeyc/blob/main/CHANGELOG.md#1054)

  - Fixes the parser to understand tuples

- Add basic type analysis for tuples

### 1.1.38

- Fix a bug introduced in 1.1.37 that could lead to duplicate diagnostics, and diagnostics with strange contents.
- Give `{ :foo => null }` the type `{ :foo => Object? }`, so that subsequent assignments to `:foo` aren't reported as type errors.

### 1.1.37

- Update to [@markw65/prettier-plugin-monkeyc@1.0.53](https://github.com/markw65/prettier-plugin-monkeyc/blob/main/CHANGELOG.md#1053)

- Features

  - Generate diagnostics for unary and binary operators with incorrect arguments
  - Properly handle object-literal types (eg `{ :foo as String, :bar as Number }`).
  - When converting Graphics.ColorValue to a number, format the number as hex.

- Tests

  - Update tests for sdk 6.3.0
  - Add more test coverage for binary operators and their expected types.

- Build

  - Use [@markw65/peggy-optimizer](https://github.com/markw65/peggy/tree/peggy-optimizer/optimizer-plugin) to optimize the jungle and resource parsers
  - Make things work properly with prettier-3.x, but don't actually upgrade yet

- Bug fixes

  - Fix a bug with the result type of A & B when A could be Boolean
  - Always include null for the types of values extracted from `Dictionary`s
  - When inferring the type of a `Dictionary`, don't include values.

### 1.1.36

- Update to [@markw65/prettier-plugin-monkeyc@1.0.52](https://github.com/markw65/prettier-plugin-monkeyc/blob/main/CHANGELOG.md#1052)
  - Fixes a bug that didn't allow `import` or `using` inside a class declaration.

### 1.1.35

- Infrastructure

  - Optimize the xml parser to speed up compilation/analysis

- Type Checker
  - More accurate tracking of Array and Dictionary types

### 1.1.34

- Optimizations

  - Add a few more peephole optimizations to the post build optimizer
    - `incsp 0;` => `nop`
    - `ipush 0; shlv` => `nop`
    - `ipush 1; shlv` => `dup 0; addv`

- Type checker
  - Add warnings for incorrect assignments to Arrays and ByteArrays
  - Properly type the elements of ByteArrays (always Number)
  - Never warn about casts to `Object?`, even if the source type might not be an `Object?`

### 1.1.33

- Update to [@markw65/prettier-plugin-monkeyc@1.0.51](https://github.com/markw65/prettier-plugin-monkeyc/blob/main/CHANGELOG.md#1051)

  - Makes it compatible with prettier@3.0.0

- Bug fixes

  - Fix a problem that could incorrectly optimize an array-init

- Optimizations

  - Enable the array-init optimization in a few more cases

### 1.1.32

- Bug fixes

  - Don't optimize `do { BODY } while (false);` to `{ BODY }` if `BODY` contains `break` or `continue`
  - In some circumstances, a comparison between a known `Long` and a known `Char` could be inferred to be false, regardless of the values (eg `42l == '*'` which should be `true`). It would eventually be folded to the correct value, but in some circumstances, an incorrect warning could be issued, or an incorrect optimization could have already been performed.

- Fixes for sdk-6.2.x

  - sdk-6.2.x fixes [this finally bug](https://forums.garmin.com/developer/connect-iq/i/bug-reports/finally-doesn-t-work-as-expected), so that now all the examples work correctly (ie the `finally` block always executes, as expected, no matter how you exit the `try` or `catch` blocks). I've updated the way the control flow graph is built to match this behavior.

  - sdk-6.2.x fixes [this continue in switch issue](https://forums.garmin.com/developer/connect-iq/i/bug-reports/continue-in-a-switch-statement-behaves-surprisingly), by making `continue` in a `switch` continue the loop containing the switch (or its a compile time error if there's no loop). This matches the behavior of C and C++, for example. I've updated the optimizer to interpret `continue` appropriately, depending on the sdk version.

### 1.1.31

- Better error reporting when getApiMapping fails
- Update getApiMapping to handle api.mir from sdk-6.2.0
- Update various tests to work with sdk-6.2.0 (including marking one test as an expected failure)
- Add a test to catch the export-project-using-barrels bug that was fixed in 1.1.30

### 1.1.30

- Bug fixes
  - Fixes an issue where exporting a project that uses barrels could fail.
  - Fixes a type analysis bug that could result in the type checker incorrectly thinking two types were disjoint.

### 1.1.29

- Bug fixes

  - Fixes an issue where a value could incorrectly be inferred to be true-ish when its declared type was known to be an object of class type. This is not of itself incorrect, but some Toybox APIs are declared as returning an Object of a class, but may in fact return null - so we can't treat them as non-null.

- Enhancements
  - various methods used by the extension for completion and hover info have been updated to give more accurate results.

### 1.1.28

- Bug fixes

  - Fixes an issue in the post build optimizer which could cause a pre-definition to be inserted just prior to an `frpush`, which could result in the wrong value of `self` being passed to a call
  - Don't add personality paths to the generated jungle file if the sdk is prior to 4.2.1
  - Fixes a bug in the source-to-source optimizer that could incorrectly infer that an `if` block was never entered when the if's comparison was between a primitive type, and a plain `Object`

- Improved optimizations
  - Constant folding between `Char` and types other than `Number` is now handled (previously such comparisons were just left for Garmin's compiler to handle). This works around a [bug in Garmin's optimizer](https://forums.garmin.com/developer/connect-iq/i/bug-reports/the-optimizer-constant-folds-char-comparisons-incorrectly) by (correctly) resolving the comparisons before Garmin's optimizer can do the wrong thing.

### 1.1.27

- Bug fixes

  - Fixes an incorrect type check warning when an assignment to a local was incompatible with the type of a same-named non-local variable. This only affects the warning; it did not result in incorrect optimizations.

- New features
  - Adds a [standalone script](https://github.com/markw65/monkeyc-optimizer/wiki/Garmin-Font-Analyzer) to analyze .cft (font) files.

### 1.1.26

- Bug fixes

  - fixes an issue in the post build optimizer which could cause pre variables to be inserted too late in a block that could throw (so that if the variable was used in, or after the catch block, it might not have been set).
  - fixes an issue with references in resource files, that could result in some references not being reported to the extension (only affects `Goto References` and `Goto Definition`)
  - fixes some issues converting the system function documentation to markdown (for the Hover, Completion and Signature providers in the extension).

- New features

  - Update to [@markw65/prettier-plugin-monkeyc@1.0.49](https://github.com/markw65/prettier-plugin-monkeyc/blob/main/CHANGELOG.md#1049) (including [#1.0.48](https://github.com/markw65/prettier-plugin-monkeyc/blob/main/CHANGELOG.md#1048) and [#1.0.47](https://github.com/markw65/prettier-plugin-monkeyc/blob/main/CHANGELOG.md#1047))
    - adds support for parsing (but not formatting) .mss files
  - Adds full support for personalities in `.jungle` and `.mss` files, including reading the per-device `personality.mss` files
  - Adds support for `project.typecheck` in `.jungle` files
  - Adds support for `project.optimization` in `.jungle` files

- Tests
  - Adds a new project to test `.mss` files, and references to personalities from `.mc` files

### 1.1.25

- Bug fixes
  - fixes a copy paste error that could cause strange results in the interpreter, possibly leading to incorrect optimizations.

### 1.1.24

- Bug fixes

  - Conversion of unary `-x` to `0 - x` was too restrictive, causing some missed optimization opportunities

- Post Build Optimizations
  - Added a pass equivalent to `Minimize Locals` in the source-to-source optimizer. This pass can see and re-assign all the locals, so it does better than the source-to-source optimizer. In addition, it maintains the variable mapping, so the debugger still sees the original names. As a result, its probably best to disable the `Minimize Locals` pass if the post build optimizer is enabled.
  - Added a pass similar to `Size Based PRE` in the source-to-source optimizer. Currently this only optimizes constants and Symbols, but it has visibility to a lot of things the source-to-source optimizer can't see; so the two passes are complementary. I've added an option in case it causes problems, but it's enabled by default when the post build optimizer is enabled.
  - Added various new optimizations to the interp pass:
    - Handles a few more byte codes
    - Conditional branches that are known to be taken, or known to be not taken are converted to gotos (and the gotos will often be eliminated by re-ordering blocks)
    - Conditional branches that would be known to be taken, or known to be not taken if evaluated at the end of one of their predecessors will be bypassed from that predecessor. Amongst other things, this converts for and while loops, that can be proven to iterate at least once, into do-while loops.
  - Improved the emitter's algorithm for ordering blocks to avoid some more gotos

### 1.1.23

No functional change, just fixes a typo that broke the typescript exports.

### 1.1.22

- Bug fixes

  - [Fixes a bug in Single Use Copy Prop](https://github.com/markw65/prettier-extension-monkeyc/issues/8)

- Post Build Optimizations
  - Updates the array-init optimizations to include `ByteArray`s
  - Integrate the array-init optimization with the new interp pass, so that changes made by interp don't interfere with array-init
  - Handle more bytecodes in interp
  - If an array is initialized to its default value, drop the initializers
  - Add an option to [remove argc bytecodes](https://github.com/markw65/monkeyc-optimizer/wiki/Post-Build-Optimizer#remove-argc)

### 1.1.21

- Bug fixes

  - fixed a bug that could cause dead-store elimination to delete stores that might be used if an exception was thrown. eg `try { x=1; foo(); x=2; } catch (ex) { System.println(x); x=3; }` could delete the first store to `x`, breaking the println if `foo` actually throws.

- Source to Source Optimizations

  - convert `++` and `--` to `+= 1` and `-= 1`. Garmin's compiler generates exactly the same code for both, but when the `1` is written explicitly, its available for `sizeBasedPRE` to optimize.
  - convert `-x` to `0 - x`. Again, Garmin's compiler generates exactly the same code, but being explicit makes the `0` available to `sizeBasedPRE`.
  - rewrite some optimizations so that `-x` and `0-x` are treated identically. eg `(0-x) + y` => `y - x` (for suitably typed `x` and `y`).
  - optimize `-1 - x` to `~x` (for suitably typed x), saving 5 bytes (or 2 if pre was going to replace the -1 with a local)

- Post Build Optimizations
  - Keep better track of exceptional edges in dce, allowing it to be more aggressive.
  - Add a (very simple) bytecode interpreter which keeps track of the values in locals, and on the stack. This allows us to opportunistically replace constants (typically 5+ bytes) with a 2 byte load from a register, or from a stack location. This (together with dce) will form the infrastructure for a future minimize-locals pass.
  - when replacing constants with locals/stack accesses, look for uses of `~`. Eg if the value `2` is in the local `x`, and we need to produce the value `-3`, we can use `~x` (costing 3 bytes, instead of 5).

### 1.1.20

- Bug fixes

  - Fix a bug that could cause the optimizer to incorrectly substitute one local for another.

- Optimizations
  - Improve dce in the post build optimizer a little, by computing which locals are live out of each block.

### 1.1.19

- Bug fixes

  - Fix "Minimize Modules" in background/glance scopes
    - due to a [bug in the monkeyc compiler](https://forums.garmin.com/developer/connect-iq/i/bug-reports/import-rez-or-using-rez-breaks-background-resources), adding "using Rez;" when a resource may be loaded by a background or glance app causes it to crash. This release won't import Rez into anything marked :background or :glance. This fixes [prettier-extension-monkeyc#7](https://github.com/markw65/prettier-extension-monkeyc/issues/7)
  - Update background and glance offsets in the program header. I had assumed these offsets were obtained from the symbols, which already get updated, but it turns out they're stored as offsets in the header. This didn't break anything, but it did mean that the background and glance code sizes were unchanged, even though the post build optimizer had in fact made them smaller.

- Optimizations
  - better optimization for arrays whose elements are all initialized to the same value (eg `[42, 42, 42, 42]`)
  - more efficient tests for symbols in case statements (ie `case: :foo`)
  - parallelize the post build optimizer when exporting a project

### 1.1.18

- add missing `worker-thread.cjs` and `worker-pool.cjs` files to the package.

### 1.1.17 (this package is missing two files)

- Project infrastructure

  - Use worker threads to speed up exporting a .iq file. With an 8 core (16 with hyperthreading) system, my project goes from taking 28 seconds to generate the optimized source to less than 10. It still takes garmin's compiler nearly 3 minutes to compile though.

- Bug fixes
  - When running the post build optimizer, the `*-settings.json` and `*-fit_contributions.json` need to be generated too.

### 1.1.16

- Project infrastructure

  - Update to [@markw65/prettier-plugin-monkeyc@1.0.46](https://github.com/markw65/prettier-plugin-monkeyc/blob/main/CHANGELOG.md#1046)
    - no functional change.
  - switch from webpack to esbuild, for faster builds, and better packaging.
  - mark the package as `commonjs` so that prettier-extension-monkeyc can set `moduleResolution: nodenext`

- Optimizations
  - Make local dce smarter
    - all locals are dead at function exits
  - Make block sharing smarter
    - allow partial blocks to be merged
    - better heuristics for when its advantageous to merge small blocks
  - Better control flow optimizations
    - Merge "linear" blocks, where the first has a single successor, and the second has a single predecessor
    - Avoid `goto` when the target is fewer than 3 bytes
  - Optimize array initialization by using a loop
  - Identify arrays that are unused, and make it possible for dce to clean up their initializers.

### 1.1.15

- Post build optimizer improvements

  - Simplify LogicalExpressions. This generally saves 3 bytes per `&&` or `||`, and also makes them faster
  - Adds a simple code sharing pass. If multiple code paths converge to the same point (or leave the function via return) and they end with the same sequence of bytecode, they're merged into one.
  - Flips branch-true to branch-false or vice versa if the fall through block has multiple predecessors, and the target block has just one. This often leads to better control flow, reducing the number of "goto" bytecodes required.

- Source to Source Optimizer improvements
  - Adds an `Iterate Optimizer` option that causes the optimizer to keep re-running until it finds nothing to remove. Defaults to false.

### 1.1.14

- Fixes a bug that could crash the optimizer if it tried to inline a function in a non-local variable's initializer.
- Adds a post build optimizer. This step takes the built .prg file, and optimizes the bytecode. Currently the optimizations are:
  - Remove unreachable code
  - simplify control flow by removing branches to branches
  - Remove empty "finally" handlers (every try/catch gets an empty finally handler)
  - Remove stores to dead locals
  - Remove side-effect free code that produces an unused result
  - Optimize shift left by constant to multiply, since the bytecode is smaller (this seems to be a bug in the garmin tools; they consider shift left and shift right to have an 8-bit argument, but its always zero, and the simulator and devices treat it as a one byte shift instruction, followed by a one byte nop).

### 1.1.13

- Adds a new [Minimize Modules](https://github.com/markw65/monkeyc-optimizer/wiki/Optimizing-module-imports#minimize-modules) pass, which attempts to ensure that every module referenced by the program is imported.

### 1.1.12

- Update to [@markw65/prettier-plugin-monkeyc@1.0.45](https://github.com/markw65/prettier-plugin-monkeyc/blob/main/CHANGELOG.md#1045)
  - fixes some bugs that could cause comments to go missing, resulting in an internal error from the formatter
- Streamline some of the data structures used for `Minimize Locals` and `Single Copy Prop` to reduce memory use, and speed things up a little.
- Fix a bug that could cause incorrect copy propagation in loops
- Add support for update assignments in copy propagation (so that `var x = a; x += b; return x` goes to `return a + b`)

### 1.1.11

- Update to [@markw65/prettier-plugin-monkeyc@1.0.44](https://github.com/markw65/prettier-plugin-monkeyc/blob/main/CHANGELOG.md#1044)

  - Fixes a parser bug relating to Methods returning Void, and a printer bug relating to nested Method declarations.

- Bug fixes
  - Fixes an odd bug that could remove assignments to a global with the same name as an unused local, if the local was declared part way through a block, and the global was used before the declaration of the local.
  - Fix some asserts related to complex member expressions that could fire in unusual circumstances
- New features
  - Constant fold instanceof expressions
  - Add more Toybox functions to sysCallInfo, so the optimizer knows they have no side effects
  - Remove top level, side-effect free expressions
  - Propagate any :typecheck annotations from inlined functions to their callers
  - Fix some issues keeping track of function calls used as arguments to inlined functions, that could result in bogus diagnostics.
  - Implement [Single Use Copy Propagation](https://github.com/markw65/monkeyc-optimizer/wiki/Local-variable-elimination#single-use-copy-propagation)

### 1.1.10

- Bug fixes
  - Fix a bug that could cause inlined code to not get fully optimized
  - Fix costs for pre of Long and Double constants, so that values that are used twice (rather than 3 times) will be subject to pre
  - Fix some issues tracking the contents of Objects. In some circumstances, if two objects could be aliased, an assignment to a field of one of them might not be recognized as affecting the other.
  - Don't warn about inlining failing if constant folding succeeds.
  - In the vscode extension, in some cases `Go to Definition` worked for a resource (eg a Menu), but then `Go to References` said there were none. This was caused by incorrect source location in the (fake) resource code.

### 1.1.9

- Update to [@markw65/prettier-plugin-monkeyc@1.0.43](https://github.com/markw65/prettier-plugin-monkeyc/blob/main/CHANGELOG.md#1043)

- Bug fixes

  - fix an interaction between inlining and removing unused local vars that could cause unlimited recursion leading to stack overflow

- New optimizations
  - Adds a `minimizeLocals` pass which runs after `sizeBasedPRE` and attempts to re-use local variables in order to reduce the total number, and hence reduce the stack size.

### 1.1.8

- Bug fixes

  - After making a non-modifying change to a variable, update the types of all equivalent variables. eg in `var x = y; if (y != null) { whatever }` we know that x is not null in `whatever`, even though we didn't explicitly test it.
  - Fix an issue with `import` and `using`. If an import happened after the definition of an inline function, inlined copies of the function might incorrectly use those imports resulting in finding the wrong symbols. This was rare - most imports happen at the top of the file, and generally an import will simply make something work that would have failed, rather than changing the behavior of something that already works. But I added a test case that exhibits the problem.

- New features
  - Add support for completion style lookups - find all the names available in the current context that fuzzy match a given string
  - Add helpers to read the function documentation from api.debug.xml
  - Add an option to visitReferences to only find a specific definition, rather than all definitions for that name in the current scope.

### 1.1.7

- Bug fixes
  - Fix a problem with inlining that could inadvertently make locals from the callee function appear to belong to the callee's class or module. This could sometimes block optimizations, and also cause confusion for the type checker.

### 1.1.6

- Bug fixes
  - Fix an issue in restrictByEquality when restricting a union including an Enum, to a specific value of the enum.
  - Fix the display of Method types to match the syntax used in MonkeyC.
  - Infer the type of `method(:symbol)` by looking up symbol.

### 1.1.5

- Bug fixes
  - Always evaluate a constant's initializer to determine its type
  - Fix a bug refining the object type based on the properties it accesses that could lose the type of the object.

### 1.1.4

- Optimizations

  - Minor tweaks to dead store elimination
  - Better type resolution for untyped code

- Enhancements

  - Retain the type map in the analysis pass, so that it can be used to improve
    the results in visitReferences

- Bug fixes

  - When multiple diagnostics were reported for a single location, all but the last was lost
  - Sometimes when evaluating MemberExpressions type-flow would give up too easily, resulting
    in unknown types for the object, which then resulted in unexpected error messages from
    the type checker, often involving seemingly unrelated classes.
  - Inlining history was sometimes lost when further optimizations were performed.

- Code cleanup
  - refactor some of the type code for better type safety
  - turn on the eslint rule eqeqeq and fix all the issues

### 1.1.3

- Tweaks and fixes

  - Update to [@markw65/prettier-plugin-monkeyc@1.0.42](https://github.com/markw65/prettier-plugin-monkeyc/blob/main/CHANGELOG.md#1042)
  - Fixed an issue that cause inlining in return context to be too conservative
  - Update inliner to keep a stack of locations, so that error messages can show exactly where an error occurred, even in the presence of inlining.
  - Update diagnostic api to optionally include a uri to more detailing information.

- Type Analysis

  - Track type info through branch conditions, so that in `if (x != null) { A } else { B }`, the type checker knows that x is not null in A, and it is null in B.
  - Added checkers for return types, call arguments, assignments and variable declarations.
  - Automatically infer Array and Dictionary types
  - Track equivalencies, and use them for various optimizations.
  - Add support for "strong" and "weak" type checking.
  - Add type analysis to getProgramAnalysis.

- Optimizations
  - Eliminate self-assignments (eg `x = x;`, but also `x = a; y = a; ... y = x;`).
  - Eliminate dead stores.
  - Replace more expensive accesses by less expensive ones.
  - Delete empty else blocks.
  - Delete if statements with empty body and no else.

### 1.1.2

- Fix a couple of edge cases when constant folding == and !=
- Optimize `<boolean> && false`, and `<boolean> || true`, when `<boolean>` has no side effects
- Better optimization of inlined function bodies
- Analyze constants with casts to help with constant propagation
- Ignore widening casts (eg a cast that is given a `Number` and converts it to `Number or String`)
- More accurate deletion of unused constants. Sometimes a constant that was unused after the optimization phase ended, was still considered used because of references that were eventually deleted.

### 1.1.1

- Fix the package spec to include the new .d.ts files

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

### 1.0.45

- Update to [@markw65/prettier-plugin-monkeyc@1.0.41](https://github.com/markw65/prettier-plugin-monkeyc/blob/main/CHANGELOG.md#1041)

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

### 1.0.44

- Update to [@markw65/prettier-plugin-monkeyc@1.0.40](https://github.com/markw65/prettier-plugin-monkeyc/blob/main/CHANGELOG.md#1040)

  - Fixes location ranges associated with parenthesized expressions
  - Fixes parsing of Lang.Char literals

- Add more parsing of expressions embedded in resource files. This should now be complete, in that the analysis pass should see every symbol definition and reference from anywhere in the project.
- Generalize constant folding to (nearly) all supported types. We don't fold additions between Float or Double and String, because the exact behavior is [buggy and unpredictable](https://forums.garmin.com/developer/connect-iq/i/bug-reports/sdk-4-1-7-constant-folds-floats-strings-incorrectly)

### 1.0.43

- Update to [@markw65/prettier-plugin-monkeyc@1.0.39](https://github.com/markw65/prettier-plugin-monkeyc/blob/main/CHANGELOG.md#1039)

  - Fixes issues parsing/printing/optimizing NaN

- Fix issues with windows paths introduced in 1.0.42
- Add Symbols (`:name`) to the list of things the inliner knows are constants
- Propagate `:typecheck(false)` to the caller when inlining
- Fix an issue with bogus undefined symbols being reported against manifest.xml in some projects that use barrels.

### 1.0.42

- Update to [@markw65/prettier-plugin-monkeyc@1.0.38](https://github.com/markw65/prettier-plugin-monkeyc/blob/main/CHANGELOG.md#1038)

  - faster parsing
  - supports parsing the attributes in api.mir, including sdk version etc.

- Performance

  - Using the updated prettier-plugin-monkeyc halves the time spent in the parser
  - There was some pathological behavior in the jungle processing. For most projects, it was quite fast (under 1s), but the worst project I found took nearly 5 minutes. I fixed a lot of redundant processing, which dropped most projects to under 500ms, with a worst case of 20s.
  - I had some caching code to prevent reading the same resource file multiple times, but the cache didn't work properly because an async function ran in between the test of the cache, and the fill of the cache; which meant that lots of threads could test the cache and decide it needed to be filled. Fixed by caching Promises, rather than the promise results. Dropped the worst case 20s down to under 500ms, and the average down below 100ms.
  - improved incremental builds (which helps with prettier-extension-monkeyc's live analysis)

- New features
  - Resource files, and manifest.xml generate definitions and references so that prettier-extension-monkeyc can provide Goto Ref/Def between monkeyc, resource, and manifest files.

### 1.0.41

- Bug fixes
  - The fix to avoid visiting definitions from visitReferences was incomplete

### 1.0.40

- Improvements

  - Upgrade to [@markw65/prettier-plugin-monkeyc@1.0.37](https://github.com/markw65/prettier-plugin-monkeyc/blob/main/CHANGELOG.md#1037).
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

### 1.0.39

- Improvements

  - Upgrade to [@markw65/prettier-plugin-monkeyc@1.0.36](https://github.com/markw65/prettier-plugin-monkeyc/blob/main/CHANGELOG.md#1036).
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

### 1.0.38

- Allow inlining the argument to an if-statement, with the same constraints as inlining in assignment context
- Expand `assignment`, `declaration` and `if` contexts to include (recursively) the left operand of any binary operator, the operand of any unary operator, the `test` operand of any conditional operator or the `object` of a member-expression. So now it will inline `inlinableFunction` in:
  - `var x = !((inlinableFunction() + 4) == 42 ? foo() : bar());`

### 1.0.37

- Update the testing framework to launch the simulator before each test run, rather than start it once at the beginning. This is because the latest beta crashes after successfully completing.
- Update launchSimulator to check if the simulator is already running. This avoids lots of screen switching when the simulator is running on a separate desktop.
- Add optimizerVersion and extensionVersion to build-info.json.

### 1.0.36

- Update to [@markw65/prettier-plugin-monkeyc@1.0.35](https://github.com/markw65/prettier-plugin-monkeyc/blob/main/CHANGELOG.md#1035).
  - Fixes [prettier-plugin-monkeyc#1](https://github.com/markw65/prettier-plugin-monkeyc/issues/1)
  - Fixes [monkeyc-optimizer#1](https://github.com/markw65/monkeyc-optimizer/issues/1)

### 1.0.35

- Testing

  - Add a new open source project
  - Fixup tests to work with compiler2beta2

- Bug fixes
  - Fixed a bug that caused the optimizer to fail if a top level variable declared in a case statement had an initializer with side effects. This didn't produce incorrect results, the optimizer simply bailed out with an obscure error, and refused to optimize the project.

### 1.0.34

- Bug fixes

  - Fix parser to allow white space to separate attributes, in addition to comma
  - Fix optimizer to respect prettier options when formatting the optimized code

- Testing
  - rewrite test harness in typescript
  - fix up tests to work with compiler2 again, and also with compiler2 at -O0

### 1.0.33

- New features

  - Tagging a function with (:keep) will prevent the optimizer from removing it, even if it appears to be unused.

- Bug fixes
  - Fix PRE to not merge values with different types. ie Number, Long, Float and Double literals should all be treated separately, even when the compare the same.

### 1.0.32

- Bug fixes
  - Fixup the tests to run unoptimized again, and add running unoptimized to the standard test run
  - Fix PRE to not merge Numbers and Floats (ie 1 is not the same thing as 1.0), and add a test

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
  - Update to [@markw65/prettier-plugin-monkeyc@1.0.33](https://github.com/markw65/prettier-plugin-monkeyc/blob/main/CHANGELOG.md#1033)
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

### 1.0.30

- Less greedy approach to finding candidate sets
  - slightly better size reduction when globals maybe modified
- Fix the control flow after the test of a while loop
  - one of the edges was in the wrong place, leading to suboptimal solutions in some cases

Bug Fixes

- Fix a bug that could lead to the optimizer never completing
- Fix a bug that prevented inlining functions that ended in a BlockStatement
- Fix a bug that could cause nested inlined functions inlined in declarations to not be removed

### 1.0.29

- Update to `@markw65/prettier-plugin-monkeyc@1.0.32`

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

### 1.0.28

- Bug fixes
  - In some circumstances, while inlining, a parameter could be substituted, and then reprocessed. During reprocessing, it would attempt to lookup the replacement symbol, and if that was a local from the calling function it would fail (since an inline function never has access to the caller's locals). Prevent the reprocessing step from happening.

### 1.0.27

- Bug fixes
  - Update to `@markw65/prettier-plugin-monkeyc@1.0.29` to fix certain obscure comment related bugs
  - When replacing a node (especially when inlining), delete any comments contained in the old node.

### 1.0.26

- Bug fixes
  - Use `self.` rather than `ClassName.` to qualify names that would otherwise collide with locals, since that works with both public and private variables
  - Fix a bug that caused the inliner to fail to qualify certain names, even if there was a collision with an existing local variables
  - Fix some name lookup issues relating to whether the lookup is done as a type or a value.

### 1.0.25

- Bug fix
  - estree-types was missing the returnType on FunctionDeclaration. Update to latest prettier-plugin, and fix ast.ts.

### 1.0.24

- Bug fix
  - The new ast.ts didn't pick up child elements that could be either a string or a node. This resulted in it missing the name in TypeSpecPart.

### 1.0.23

- Bug Fixes

  - Don't treat parameters to Method types as undeclared variables
    - eg `var x as (Method(a as Number, b as Number) as Void)` should not report that `a` and `b` are undeclared

- Tests
  - Various new tests for module/class/local resolution of symbols
  - Make tests fail by default if the optimizer reports any undefined symbols, and add `@expects` or `checkInvalidSymbols=WARNING` as needed to prevent test failures.

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

### 1.0.21

- Bug fixes

  - Parameters from the calling function should be treated just line locals when inlining
  - Upgrade to `@markw65/prettier-plugin-monkeyc@1.0.24`
    - fixes crash with comments following an attribute: `(:foo) /* comment */ function foo() {}`
  - Fix issues with recursive inlining

### 1.0.20

- Bug fixes

  - Fix a bug marking unknown callees
  - Fix a bug in test.js that didn't notice when tests failed, and fix a failing test

- Optimizer enhancements

  - Re-run the main optimization step, to properly account for functions that are unused after optimization
  - Call the optimizer on 'unused' nodes before returning them

- Code cleanup
  - Called function cleanup

### 1.0.19

- Upgrade to `@markw65/prettier-plugin-monkeyc@1.0.22`

  - fixes some minor typing issues for mctree
  - special handling for certain parenthesized expressions.

- Optimizer

  - Handle more unused expressions, add tests, and prettify the OptimizerTests project
  - Allow statement-style inlining in assignment and return contexts
  - Add diagnostics for failure to inline

- Tests

  - More tweaks to pragma-checker
  - Add launch and task configs for building/running tests

- Code cleanup
  - Properly type the results of JSON.parse
  - Switch over to using ParenthesizedExpression for formatAst (depends on `@markw65/prettier-plugin-monkeyc@1.0.22`)

### 1.0.18

- Bug Fixes
  - The new inliner was too aggressive at constant propagating literal parameters to their point of use.

### 1.0.17

- New Features

  - Extend the inliner to support more complex functions when called in a void context
  - Cleanup unused expressions. `0;x;foo.bar;a+b` will all now be optimized away.

- Testing

  - Rewrite the @match pragma implementation to have access to the next Node in the ast, rather than just the text of the remainder of the line.
  - Add tests for the statement inliner, and the unused expression cleanup code.

- Bug Fixes
  - Fix a bug affecting lookup of types, which could cause definitions, references and links to the api docs to be missed in the vscode extension

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

### 1.0.15

- Bug fixes
  - Inject the superclass name into the classes namespace
  - Separate type vs value lookup, and use the correct one based on context.

### 1.0.14

- Bug fixes

  - When reading a barrel project with no products, add all products by default
  - Only set language specific paths for languages that are supported by the device
  - Remove comments that are completely contained within removed nodes

- Code cleanup
  - Upgrade to `@markw65/prettier-plugin-monkeyc@1.0.21` for some typescript fixes
  - npm upgrade to pickup ts 4.7.2
  - Add types to package exports for ts 4.7.2
  - Better handling of program-logic errors

### 1.0.13

- Improvements

  - Add displayName to deviceInfo (for getTargetDevices in prettier-extension-monkeyc)
  - Throw a better error when we fail to read a jungle file
  - Don't try to optimize barrel projects

- Code cleanup

  - Update to `@markw65/prettier-plugin-monkeyc@1.0.20` for mctree fixes
  - Enable typescript strict checks
  - Turn off synthetic default imports, and fix issues
  - Better manifest typing

- Tests
  - Add date/time to test logging

### 1.0.12

- Fix connectiq and vscode paths on linux, and better error reporting when they're missing

### 1.0.11

- Improvements

  - Add option to run tests (for projects that have them)
  - Add getProjectAnalysis api, to support various language features in `@markw65/prettier-extension-monkeyc`

- Bug fixes

  - Fix lookup of self/me

- Code cleanup
  - More typing. Check that build options match previous ones before re-using the optimized files
  - Move everything over to typescript
    - The project was becoming hard to maintain due to too much ad-hoc dynamic typing. This should allow easier/safer refactors and code cleanup.
  - Refactoring to make analysis available in prettier-extension-monkeyc
  - Generate .d.ts, and drop unneeded paths/resolve.alias
  - Pull in a typed version of `@markw65/prettier-plugin-monkeyc`

### 1.0.10

- Add --execute option to test.js to run the projects after building them
- Add support for optimizing barrels
- Add some typing via jsdoc, and turn on ts validation in vscode
- Bump to `@markw65/prettier-plugin-monkeyc:1.0.16` so ts recognizes its exports
- Add [garmin/connectiq-apps](https://github.com/garmin/connectiq-apps) and fix some minor issues it revealed

### 1.0.9

- Only generate the parts of the jungle we're going to use
- Also publish sdk-util.cjs
- Bump to `@markw65/prettier-plugin-monkeyc:1.0.15`
  - Fixes a bug that dropped attributes on modules
- LiteralIntegerRe should be case insensitive
- Proper fix for promiseAll
- Auto-include barrels.jungle when its present

### 1.0.8

- Improvements

  - Update to `@markw65/prettier-plugin-monkeyc:1.0.14`
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

### 1.0.6

- Bump to version 1.0.12 of `@markw65/prettier-plugin-monkeyc` to fix multiple parser bugs
- Add lots of open source projects as tests. For now, just verify that optimizing the sources succeeds, not that the generated source is actually correct.

### 1.0.5

- Bump to version 1.0.11 of `@markw65/prettier-plugin-monkeyc` to fix an ObjectLiteral parsing issue.

### 1.0.4

- Fix a bug resulting in a failure to fully optimize constants initialized by constant conditional expressions
- Make the generated .cjs files work better with es modules (vscode doesn't work with es modules, so prettier-extension-monkeyc doesn't care - but for other projects importing this package it improves the behavior)
- Generate separate debug/release jungle files.

### 1.0.3

- Split the build into release and debug, so we can exclude code based on (:release) and (:debug)
- Optimize away `if (constant)`, `while (false)` and `constant ? E1 : E2`. Convert `do BODY while(false)` to `BODY`

#### 1.0.2

- Better error reporting when something goes wrong internally
- Fix an order dependency when processing imports. Previously, if the import statement was seen before the module being imported, we would fail to properly handle the import.

#### 1.0.1

- Make a better attempt to fix all the negative constants in api.mir
- Make export explicitly do a release build by default.

#### 1.0.0

Initial release
