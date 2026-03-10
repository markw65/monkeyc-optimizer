import Toybox.Lang;

const B = true;

(:keep)
function f() as Number? {
    var x = null;
    if (B) {
        x = 0;
    }
    return x;
}
