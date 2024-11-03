enum Enum1 {
    VALUE_1,
}

enum Enum2 {
    VALUE_2 = VALUE_1,
}

function test1() as Void {
    // The type Number<0> as Enum1 as Enum2 cannot be converted to Number<0> as Enum1 because they have nothing in common
    test2(VALUE_2 as Enum1);
}

function test2(value as Enum1) as Void {}
