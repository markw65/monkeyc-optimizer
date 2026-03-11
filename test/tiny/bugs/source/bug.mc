import Toybox.Lang;

const B = true;
module M {
    const xyz = 0;
    const uvw = 0;
}

var uvw as Number = 0;

(:keep)
function f() as Number? {
    var xyz = null;
    if (B) {
        xyz = 0;
    }
    return xyz;
}

(:keep)
function g() as Number? {
    uvw = 0;
    return uvw;
}
