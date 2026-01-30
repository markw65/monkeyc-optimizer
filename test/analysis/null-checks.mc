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

/*
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
*/
