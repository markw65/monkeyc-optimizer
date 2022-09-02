import Toybox.Lang;
import Toybox.Test;

(:test)
function testUnusedVars(logger as Logger) as Boolean {
    ok = true;

    /* @match "var y;" "A.B.a();" "var v = true;" /for \(\s*var i = @0, k = A.B.a\(\); i < 10; i\+\+, y =/ */
    var x = 100,
        y = 50,
        z = A.B.a(),
        w = 0,
        v = true;
    x += 50;
    for (
        var i = 0, j = 0, k = A.B.a();
        i < 10;
        i++, x += 2, y += i != 0 && A.B.a() != 0 ? 1 : 0, ++w
    ) {
        w++;
    }
    return v && ok;
}

(:test)
function testUnusedCaseVars(logger as Logger) as Boolean {

    switch (A.B.a()) {
        case 0:
            /* @match "A.B.a();" */
            var x = A.B.a();
            break;
        case 1:
            /* @match "A.B.a();" */
            var u = 0, v = 1, y = A.B.a(), w = 2;
            break;
    }
    return true;
}
