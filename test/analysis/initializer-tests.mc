import Toybox.Lang;

class Test {
    static const CONST_1 = (1).toNumber();
    // Unexpected types for operator '+': [Number vs Null]
    static const CONST_2 = 1 + (0.5 * 2).toNumber();

    var a as Number;
    var b as Number;
    var c as Number;

    function initialize(x as Number) {
        a = x;
        b = getValue(a);
        // Argument 1 to $.Test.getValue expected to be Number but got Null or Number
        c = getValue(a);
    }

    function getValue(x as Number) as Number {
        // Unexpected types for operator '*': [Number vs Null]
        return x * CONST_1;
    }
}
