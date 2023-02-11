import Toybox.Lang;
import Toybox.Math;
import Toybox.Test;

(:test)
function uninitializedBug(logger as Logger) as Boolean {
    var emptyIndex = null;
    for (var idx = 1; idx <= 2; idx++) {
        var extAntId = Math.rand();
        if (42 == extAntId) {
            emptyIndex = idx;
            break;
        } else if (emptyIndex == null && extAntId == 0) {
            emptyIndex = idx;
        }
    }
    return true;
}
