import Toybox.Lang;
import Toybox.System;

function wantsString(s as String) as String {
    System.println(s);
}
function wantsFloat(f as Float) as Float {
    System.println(f);
}

function wantsTuple(t as [Number, String, Boolean]) as Void {
    System.println(t);
}

function wantsArray(a as Array<Number or String>) as Void {
    System.println(a);
}

(:keep)
function tuple1() as [Number, String, Boolean] {
    var tuple = [1, "Hello", false];
    // @expect "expected to be String but got Number"
    wantsString(tuple[0]);
    wantsString(tuple[1]);
    // @expect "expected to be String but got Boolean"
    wantsString(tuple[2]);
    return tuple;
}

(:keep)
function tuple2() as [Number, String, Boolean, Float] {
    var tuple = tuple1();
    tuple.add(42.0);
    wantsFloat(tuple[3]);
    tuple[1] = 42;
    // @expect "to return [Number, String, Boolean, Float] but got [Number, Number, Boolean, Float]"
    return tuple;
}

(:keep)
function tuple3(
    tuple as [Number, String, Boolean, Float]
) as [Number, String, Boolean, Float] {
    tuple[1] = 42;
    // @expect "to return [Number, String, Boolean, Float] but got [Number, Number, Boolean, Float]"
    return tuple;
}

(:keep)
function passesTuple() as Void {
    wantsTuple([1, "Hello", false]);
    wantsTuple(tuple1());
    // @expect "expected to be [Number, String, Boolean] but got [Number, String, Boolean, Float]"
    wantsTuple(tuple2());
}

(:keep)
function returnsTupleAsArray(x as Number) as Array<Number or String> {
    switch (x) {
        case 0:
            return [x, "Hello"];
        case 1:
            return [x, x];
        case 2:
            return ["Hello", "World"];
        case 3:
            // @expect "to return Array<Number or String> but got [Number, Boolean]"
            return [x, false];
        case 4:
            // @expect "to return Array<Number or String> but got [Number, String, Boolean]"
            return [x, "Hello", true];
    }
}

(:keep)
function passTupleAsArray() as Void {
    wantsArray([42]);
    wantsArray(["Hello"]);
    // @expect "expected to be Array<Number or String> but got [Boolean]"
    wantsArray([false]);
    wantsArray([42, "Hello"]);
    // @expect "expected to be Array<Number or String> but got [Number, String, Boolean]"
    wantsArray([42, "Hello", true]);
}
