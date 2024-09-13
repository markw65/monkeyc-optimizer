import Toybox.Lang;
import Toybox.Math;

import TestMod.Inner;

const GLOBAL as Number = Inner.CONST as Number;

module TestMod {
    const CONST_1 = Math.sin(0).toNumber();
}

class Test {
    static const CONST_1 = (1).toNumber();
    static const CONST_2 = 1 + (0.5 * 2).toNumber();

    var a as Number;
    var b as Number;
    var c as Number;

    function initialize(x as Number) {
        a = x;
        b = getValue(a);
        c = getValue(a);
    }

    function getValue(x as Number) as Number {
        a = TestMod.CONST_1;
        b = TestMod.CONST_2;
        c = TestMod2.CONST_1;
        return x * CONST_1 * TestMod.ENUM_1 * Inner.CONST * GLOBAL;
    }
}

module TestMod {
    const CONST_2 = TestMod2.CONST_1 + 1;
    enum {
        ENUM_1 = TestMod2.CONST_1,
    }
    module Inner {
        const CONST = Test.CONST_2;
    }
}

module TestMod2 {
    const CONST_1 = (Math.sin(1) * 5).toNumber();
}

class Test2 {
    enum Enum {
        ENUM_VALUE = 1 << 0,
    }

    // The type :value cannot be converted to Number because they have nothing in common
    function test(value as Enum or Number) as { :value as Number } {
        // Unexpected types for operator '&': [Null or Float or Double or Char or String vs Number]
        return { :value => (value & ENUM_VALUE) == ENUM_VALUE ? 1 : 0 };
    }

    var value as Float;

    function initialize() {
        value = ENUM_VALUE.toFloat(); // Invalid assignment to value. Expected Float but got Null or Float [pmc-analysis]
    }
}
