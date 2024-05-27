import Toybox.Lang;
import Toybox.Test;
import Toybox.WatchUi;

(:test)
function testRezStarTypes(logger as Logger) as Boolean {
    var x = WatchUi.loadResource(Rez.Strings.AppName);
    return x.equals("OptimizerTests");
}

function testChar(c as Char) as Boolean {
    return '0' <= c && c <= '9';
}

(:typecheck(false))
function testStrChar(c as String) as Boolean {
    // @expect "Unexpected types for operator"
    return '0' <= c && c <= '9';
}

(:typecheck(false))
function testStr(c as String) as Boolean {
    // @expect "Unexpected types for operator"
    return "0" <= c && c <= "9";
}

(:test)
function testCharComparisons(logger as Logger) as Boolean {
    return testChar('5') && !testChar('z');
}

(:test)
function testCharStrComparisonsCrash(logger as Logger) as Boolean {
    return testStrChar("5") && !testStrChar("z");
}

(:test)
function testStrComparisonsCrash(logger as Logger) as Boolean {
    return testStr("5") && !testStr("z");
}

function strAdd(
    str as String,
    sym as Symbol,
    m as (Method() as String),
    o as Object
) as String {
    return str + sym + " " + m + " " + o;
}

(:test)
function testStrAddition(logger as Logger) as Boolean {
    strAdd("foo", :foo, (1).method(:toString), new Lang.Object());
    return true;
}

class EnumWithSingleValueTest {
    enum Enum {
        VALUE,
    }

    var enumValue as Enum;

    var value as Number;

    function initialize() {
        // @match "enumValue = 0"
        enumValue = VALUE;

        value = getValue();
    }

    function getValue() as Number {
        return enumValue == VALUE ? 1 : 0;
    }
}

(:test)
function testSingleEnumInit(logger as Logger) as Boolean {
    var testObj = new EnumWithSingleValueTest();
    return (
        testObj.enumValue == EnumWithSingleValueTest.VALUE && testObj.value == 1
    );
}
