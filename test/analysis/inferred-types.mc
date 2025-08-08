import Toybox.Lang;
import Toybox.System;

function assign_to_null_element() {
    var t = [0, null];
    t[1] = 42;
}

function assign_to_specific_valued_element() {
    var t = [0];
    t[0] = 42;
}

function expect_tuple(t as [Number, Number?]) {
    System.println(t);
}

function pass_null_element() {
    expect_tuple([0, null]);
}
