import Toybox.Lang;
import Toybox.Application;
import Toybox.Application.Storage;
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

class TestClass {
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
            (x instanceof String ? 1 : 0) +
            (x instanceof Object ? 1 : 0) +
            (x instanceof Dictionary ? 1 : 0) +
            (x instanceof Array ? 1 : 0)
        );
    }
    static function noNumberStatic(x as Number or String) as Boolean {
        // Fails at runtime: "Could not find symbol 'Number'"
        /* @expect "Undefined symbol Number" */
        return x instanceof Number;
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
