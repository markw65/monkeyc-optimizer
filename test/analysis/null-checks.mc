import Toybox.Time;
import Toybox.Lang;
import Toybox.System;

class C1 {
    var x as Array<Array<Number> > = [[0]];
    function f1() as Void {
        System.println("Hello");
        // x[0][0] = 1;
    }
}

class C2 extends C1 {
    private var x as Number?;
    private var y as Number?;

    function initialize() {
        C1.initialize();
    }

    function f2() as Number {
        if (x != null && y != null) {
            f1();

            return x + y; // Unexpected types for operator '+': [Number vs Null], [Null vs Null or Number]
        } else {
            return 0;
        }
        return;
    }
}

class C3 {
    private var z as Array<Number>?;

    function f3() as Array<Number> {
        if (z != null) {
            (z as Array<Number>)[0] = 0;

            return z; // Expected $.C3.f3 to return Array<Number> but got Null or Array<Number>
        } else {
            return [] as Array<Number>;
        }
    }
}

function m() as Moment {
    return new Moment(0);
}

var z as Array<Number>?;

function f(d as Duration?) as Moment? {
    if (z != null) {
        var m = m();
        z[0] = 0;
        return d != null ? m.add(d) : null;
    }
}

function nullable_call(d as Dictionary?) as Number {
    // @expect "The object in this expression could be Null"
    return d.get("x") as Number;
}

class C {
    var value as Number;
}

function nullable_variable(c as C?) as Number {
    // @expect "The object in this expression could be Null"
    return c.value as Number;
}
