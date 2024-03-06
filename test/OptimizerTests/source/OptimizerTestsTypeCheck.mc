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
    return (
        testChar('5') &&
        !testChar('z')
    );
}

(:test)
function testCharStrComparisonsCrash(logger as Logger) as Boolean {
    return (
        testStrChar("5") &&
        !testStrChar("z")
    );
}

(:test)
function testStrComparisonsCrash(logger as Logger) as Boolean {
    return (
        testStr("5") &&
        !testStr("z")
    );
}
