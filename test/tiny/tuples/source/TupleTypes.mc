import Toybox.Lang;
import Toybox.System;

class Test1 {
    function initialize(value as [Number]) {}
}

class Test {
    var array as Array<Number>;
    var value as Number;

    function initialize() {
        array = getArray([0]);
        value = getTuple(0)[0];

        System.println(array);
        System.println(value);
    }

    function getArray(values as Array<Number>) as Array<Number> {
        var result = [];

        result.addAll(values);

        return result;
    }

    function getTuple(value as Number) as [Number, Float] {
        return [value, value.toFloat()];
    }
}
