import Toybox.Lang;
import Toybox.Test;

(:test)
function testUnusedVars(logger as Logger) as Boolean {
    ok = true;

    /* @match "A.B.a();" /i = @0; A.B.a\(\); for \( ; i < 10; i \+= 1, y =/ */
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
            var u = 0,
                v = 1,
                y = A.B.a(),
                w = 2;
            break;
    }
    return true;
}

(:test)
function testDeadVars(logger as Logger) as Boolean {
    ok = true;
    {
        /* @match "u = wrapper" /^A.B.a\(\);$/ "check(u + wrapper(2)," */
        var u = wrapper(1),
            x = A.B.a(),
            v = wrapper(2);

        check(u + v, 3, logger);
    }

    {
        /* @match "u = wrapper" /^A.B.a\(\);$/ "check" */
        var u = wrapper(1),
            x = A.B.a();
        check(u, 1, logger);
    }

    {
        /* @match /^A.B.a\(\);$/ "v = wrapper" "check(wrapper(" */
        var x = A.B.a(),
            v = wrapper(2);

        x = wrapper(1);
        check(x + v, 3, logger);
    }

    {
        /* @match /x = 0; for \(; x < 10; x \+= @1\)/ */
        for (var x = 0, i = 0; x < 10; x++, i += 2) {
            i = x + 1;
            logger.debug(i);
        }
    }

    return ok;
}
