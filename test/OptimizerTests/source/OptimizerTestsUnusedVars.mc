import Toybox.Lang;
import Toybox.Test;

(:test)
function testUnusedVars(logger as Logger) as Boolean {
    ok = true;

    /* @match "var y;" "A.B.a();" "var v = true;" /for \(var i = @0, k = A.B.a\(\); i < 10; i\+\+, y =/ */
    var x = 100,
        y = 50,
        z = A.B.a(),
        w = 0,
        v = true;
    x += 50;
    for (
        var i = 0, j = 0, k = A.B.a();
        i < 10;
        i++, x += 2, y += i != 0 && A.B.a(), ++w
    ) {
        w++;
    }
    return v && ok;
}
