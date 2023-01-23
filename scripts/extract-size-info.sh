#!/bin/bash
# Process the output of
#  node ./test/test.js --showInfo ...
# and produce an Array<{ file: string; code: number; data: number }>
# with the sizes for each target.

sed -n '/^optimized/ {N; s/^optimized-\(.*\) sizes: text: \([0-9]*\) data: \([0-9]*\).*Done:.* - \(.*\/\)[^\/]*.jungle$/{"file":"\4\1","code":\2,"data":\3}/; p;}' $1 | jq -s .