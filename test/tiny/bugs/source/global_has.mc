import Toybox.Lang;
import Toybox.System;

var foobarbiz as Number = 42;

(:keep)
function test_missing_has() as Void {
    // @match "if (Lang"
    if (Lang has :InvalidValueException) {
        System.println("The if should remain");
    }
    // @match "if ($"
    if ($ has :foobarbiz) {
        System.println("This is expected");
    }
    // @match "return;"
    if ($ has :foobarbaz) {
        System.println("This shouldn't happen");
    }
    return;
}
