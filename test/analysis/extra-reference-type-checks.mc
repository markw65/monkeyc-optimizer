import Toybox.Lang;
import Toybox.System;

function wantsNumberArray(a as Array<Number>) as Number {
    return a[0];
}
function wantsStringArray(a as Array<String>) as String {
    return a[0];
}

function makeTuple(v as Number) as [Number] {
    return [v];
}
var array1 as Array<Number or String> = [];
var array2 as Array<Number> or Array<String> = [];

(:keep)
function arrayAssignTuple(v as Number) as Array<Number> {
    var t;

    // @expect "Unsafe assignment to array1: assigning"
    array1 = makeTuple(v);
    if (v == 1) {
        return array1;
    }
    array1[0] = "Hello";
    wantsStringArray(array1);
    // The type checker has noticed that array1 and t refer to the same thing,
    // and knows that t is now a [String], rather than a [Number]. The
    // extraReferenceTypeChecks warning was suppressed for array1, because it's
    // declared type is Array, not Tuple. But t doesn't have a declared type, and
    // makeTuple explicitly returns a tuple, so we do get a "type safety" warning
    // here

    array1 = [42];
    if (v == 2) {
        return array1;
    }
    wantsNumberArray(array1);

    // @expect "Unsafe assignment to array2: assigning"
    array2 = makeTuple(v);
    if (v == 3) {
        return array2;
    }
    // @expect "Invalid assignment to array2[0]. Expected Number but got"
    array2[0] = "Hello";
    wantsStringArray(array2);

    array2 = ["Hello"];
    wantsStringArray(array2);

    array2 = [42];
    if (v == 4) {
        return array2;
    }
    wantsNumberArray(array2);
    return [];
}
