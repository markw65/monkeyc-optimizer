import Toybox.Lang;
import Toybox.Test;
import Toybox.Application;
import Toybox.Application.Storage;
import Toybox.WatchUi;
import A.B;

(:inline)
function inlineNeedsLocalImport() as Number {
    return B.a();
}

(:inline)
function inlineNeedsToyboxImport() as PropertyValueType {
    return Application has :Storage ? Storage.getValue("a") : null;
}

(:typecheck(false))
function noSystem() as Void {
    // Fails at runtime: "Could not find symbol 'System'"
    /* @expect "Undefined symbol System.println" */
    System.println(0);
}

function noNumber(x as Number or String) as Boolean {
    // Fails at runtime: "Could not find symbol 'Number'"
    /* @expect "Undefined symbol Number" */
    return x instanceof Number;
}

function properties() as Void {
    /* @expect "Undefined symbol Properties.getValue" */
    Properties.getValue("What");
}

class Dictionary {
}

module X {
    const XCONSTANT = 0;
    module Y {
        const YCONSTANT = 1;
        class Base {
            const BCONSTANT = 0;
        }
    }
    module Z {
        const ZCONSTANT = 2;
    }
}
class TestClass extends X.Y.Base {
    function initialize() {
        Base.initialize();
    }
    const FOO as Number = ENDIAN_BIG as Number;
    function noSystem() as Void {
        // works!
        System.println(Communications.UNKNOWN_ERROR as Number);
    }
    function noNumber(
        x as Number or String or Dictionary or Lang.Dictionary or Array
    ) as Number {
        // works!
        return (
            (x instanceof Number ? ENDIAN_BIG : ENDIAN_LITTLE) +
            (x instanceof String ? YCONSTANT : XCONSTANT) +
            (x instanceof Object ? Z.ZCONSTANT : 0) +
            (x instanceof Dictionary ? 1 : 0) +
            (x instanceof Array ? 1 : 0)
        );
    }
    static function noNumberStatic(x as Number or String) as Boolean {
        // Fails at runtime: "Could not find symbol 'Number'"
        /* @expect "Undefined symbol Number" */
        var t = x instanceof Number;
        /* @expect "Undefined symbol XCONSTANT" */
        return t || XCONSTANT == 0;
    }
    function properties() as Void {
        /* @expect "Undefined symbol Properties.getValue" */
        Properties.getValue("What");
    }
}

(:test)
function lookupTestsWorking(logger as Logger) as Boolean {
    logger.debug(TestClass.FOO == null ? "Null" : "ERROR");
    var x = new TestClass();
    logger.debug(x.FOO.toString());
    x.noSystem();
    logger.debug(x.noNumber(1).toString());
    logger.debug(x.noNumber(new $.Dictionary()).toString());
    logger.debug(x.noNumber({ "a" => "b" }).toString());
    return true;
}

(:test,:typecheck(false))
function lookupInOuterScope(logger as Logger) as Boolean {
    ok = true;
    check(X.Y.XCONSTANT, 0, logger);
    check($.X.Y.XCONSTANT, 0, logger);
    return ok;
}

(:test)
function lookupTestCrash1(logger as Logger) as Boolean {
    noSystem();
    return false;
}
(:test)
function lookupTestCrash2(logger as Logger) as Boolean {
    $.Toybox.System.println(noNumber(1));
    // prior to compiler 2, noNumber crashes
    // afterwards, its fine
    return true;
}
(:test)
function lookupTestCrash3(logger as Logger) as Boolean {
    $.Toybox.System.println(TestClass.noNumberStatic(1));
    // prior to compiler 2, noNumberStatic crashes
    // afterwards, its fine
    return true;
}
(:test)
function lookupTestCrash4(logger as Logger) as Boolean {
    $.properties();
    return false;
}
(:test)
function lookupTestCrash5(logger as Logger) as Boolean {
    var x = new TestClass();
    x.properties();
    return false;
}

/*
 * Check the superclass search order, which is weird
 *
 * The search order from within X should be:
 *  - Search X itself
 *  - Search B.Mid (the super class)
 *  - Search MA.Base (the super class's super class)
 *  - Search Toybox.Lang.Object (the implied super super super class)
 *  - Search outwards from X to the global module
 *  - Search outwards from Mid to the global module
 *  - Search outwards from Base to the global module
 *  - Search outwards from Object to the global module
 */
module MA {
    module B {
        const K1 = 2;
    }
    const FOOA = 1;
    const FOOB = 1;
    const FOOC = 1;
    var x as Symbol?;
    class Base {
        const SUPERA = 2;
        const SUPERB = 2;
        const SUPERC = 2;
        function initialize() {
            // don't let the compiler remove
            // checkUsingScope below.
            x = :checkUsingScope;
        }
    }
    // make sure checkUsingScope wasn't optimized away
    /* @match "checkUsingScope" */
    function checkUsingScope() as Number {
        // keep it from being optimized away
        methodArgsArentInvalidSymbols(null);
        // should find B via import A.B
        // not from MA.B above.
        /* @match "return 1;" */
        return B.K1;
    }

    // Make sure we don't report axxy, bxxy and cxxy as invalid symbols
    function methodArgsArentInvalidSymbols(
        m as Null or (Method(axxy as Number, bxxy as Number, cxxy) as Void)
    ) as Void {}
}

module MB {
    const FOOB = 3;
    const FOOC = 3;
    class Mid extends MA.Base {
        function initialize() {
            Base.initialize();
        }
        const SUPERB = 4;
        const SUPERC = 4;
    }
}

module MC {
    const FOOC = 5;
    class X extends MB.Mid {
        const SUPERC = 6;
        function initialize() {
            Mid.initialize();
            /* @match "(1)" */
            System.println(FOOA);
            /* @match "(3)" */
            System.println(FOOB);
            /* @match "(5)" */
            System.println(FOOC);
            /* @match "(2)" */
            System.println(SUPERA);
            /* @match "(4)" */
            System.println(SUPERB);
            /* @match "(6)" */
            System.println(SUPERC);
            /* @match "(1)" */
            System.println(B.K1);
        }
        class Y {
            (:typecheck(false))
            function initialize() {
                /* @expect "Undefined symbol FOOB" */
                System.println(FOOB);
                /* @expect "Undefined symbol SUPERB" */
                System.println(SUPERB);
                /* @expect "Undefined symbol FOOC" */
                System.println(FOOC);
                /* @expect "Undefined symbol SUPERC" */
                System.println(SUPERC);
                /* @expect "Undefined symbol Mid" */
                System.println(Mid.SUPERB);
            }
        }
    }
}

module Inheritance {
    class Base {
        hidden var h as Number = 1;
        private var p as Number = 1;
        (:inline)
        function badQualifier() as Number {
            var x = p;
            return x;
        }
        function foo() as Number {
            var p;
            /* @match /var x = self.p;/ /return p \+ 24;/ */
            p = badQualifier();
            return p + 24;
        }
    }
    class Child extends Base {
        (:inline)
        function localConflict() as Number {
            return h;
        }
        (:inline,:typecheck(false))
        function localPrivate() as Number {
            return p;
        }
        function bar() as Number {
            var h = 42;
            /* @match "self.h + h" */
            return localConflict() + h;
        }
        (:typecheck(false))
        function baz() as Number {
            var p = 42;
            /* @match "self.p + p" */
            return localPrivate() + p;
        }
    }
    (:test)
    function inherit(logger as Logger) as Boolean {
        var x = new Child();
        return x.bar() == 43 && x.foo() == 25;
    }
    (:test)
    function crashOne(logger as Logger) as Boolean {
        var x = new Child();
        return x.baz() == 43;
    }
}
