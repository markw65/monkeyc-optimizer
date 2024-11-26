import Toybox.Lang;

class Test {
    typedef EnumType as Enum1 or Enum2;

    enum Enum1 {
        ENUM1,
    }
    enum Enum2 {
        ENUM2_1,
        ENUM2_2,
    }
    enum Enum3 {
        ENUM3,
    }
    enum Enum4 {
        ENUM4_1,
        ENUM4_2 = false,
    }

    function test1() as Number {
        return test2();
    }
    function test2() as Number {
        // Argument 1 to $.Test.test3 expected to be Enum but got Number<0>
        return test3(ENUM2_1, ENUM3);
    }
    function test3(value1 as EnumType, value2 as Enum3) as Number {
        switch (value2) {
            case ENUM3: {
                return 1;
            }
            default: {
                return 0;
            }
        }
    }
}
