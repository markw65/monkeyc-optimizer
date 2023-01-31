#!/bin/bash

# Use extract-size-info.sh to produce old and new from the output
# of `node ./test/test.js --showInfo ...`
# Then feed those to sizes.sh to compare the old and new and
# show a summary sorted by biggest decrease.

old=$1
new=$2
echo old: $old
echo new: $new
jq -n \
  --argjson old "$(jq 'map({key:.file,value:{code,data}})|from_entries' $old)" \
  --argjson new "$(jq 'map({key:.file,value:{code,data}})|from_entries' $new)" \
  '$old | keys | map($new[.] as $n|$old[.] as $o|{key:.,value:{new:$n, old:$o, delta:{code:($n.code - $o.code), data:($n.data-$o.data)},diff:($n.code - $o.code + $n.data-$o.data)}})|sort_by(.value.diff)'
