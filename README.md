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

---
