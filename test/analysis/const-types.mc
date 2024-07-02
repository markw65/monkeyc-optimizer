import Toybox.Lang;
import Toybox.Math;

class Test {

    const CONST = Math.PI.toFloat();
    function getValue(value as Number) as Numeric {
        // Unexpected types for operator '*': [Number vs Null] [pmc-analysis]
        return value * CONST;
    }
}