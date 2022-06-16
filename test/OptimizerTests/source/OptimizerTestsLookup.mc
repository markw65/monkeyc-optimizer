import Toybox.Lang;
import Toybox.Application;
import Toybox.Application.Storage;
import Toybox.WatchUi;
import A.B;

var gRunFailingTests as Boolean = :lookupTests == null;

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
    const FOO = ENDIAN_BIG;
    function noSystem() as Void {
        // works!
        System.println(Communications.UNKNOWN_ERROR as Number);
    }
    function noNumber(
        x as Number or String or Dictionary or Lang.Dictionary
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

function lookupTests() as Void {
    // all work
    $.Toybox.System.println(TestClass.FOO as Number);
    var x = new TestClass();
    $.Toybox.System.println(TestClass.FOO as Number);
    x.noSystem();
    $.Toybox.System.println(x.noNumber(1));
    $.Toybox.System.println(x.noNumber(new $.Dictionary()));
    $.Toybox.System.println(x.noNumber({ "a" => "b" }));

    if (gRunFailingTests) {
        // all fail
        noSystem();
        $.Toybox.System.println(noNumber(1));
        $.Toybox.System.println(TestClass.noNumberStatic(1));
        $.properties();
        x.properties();
    }
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
    class Base {
        const SUPERA = 2;
        const SUPERB = 2;
        const SUPERC = 2;
    }
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
