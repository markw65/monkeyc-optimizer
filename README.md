# monkeyc-optimizer README

This package provides a set of utilities for working with Garmin Monkey-C projects.

#### Optimization and analysis

Its primary purpose is to serve as the optimization and analysis engine behind [prettier-extension-monkeyc](https://marketplace.visualstudio.com/items?itemName=markw65.prettier-extension-monkeyc). Although it could be used separately to optimize and analyze Monkey-C projects, most of the API is not expected to be stable (ie it will change as required by `prettier-extension-monkeyc`).

#### Font analysis

It also provides a tool to report information about the builtin fonts on a device. This can be used to compute layouts, or make decisions about whether a given string would fit in a given screen region at build time, rather than at runtime. [More details](https://github.com/markw65/monkeyc-optimizer/wiki/Garmin-Font-Analyzer)

## Release Notes

See [Change Log](CHANGELOG.md)
