import Toybox.Application;
import Toybox.Lang;

typedef PVT as Lang.Array<PVT> or Lang.Dictionary<String, PVT>;

typedef VT as Number or Lang.Array<VT> or Lang.Dictionary<String, VT>;
var pvt as PVT;
var vt as VT;

function bad(flag as Boolean, i as Number) as Boolean {
    var s = flag ? vt : pvt;
    if (!(s instanceof Toybox.Lang.Array)) {
        return false;
    }

    if (s[i] != null) {
    }
    return true;
}
