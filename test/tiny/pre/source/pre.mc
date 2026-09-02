import Toybox.Lang;

var dictionary as Dictionary<Number, Number>?;
var d2 as Dictionary<Number, Number>?;

(:keep)
function f(x as Number) as Number? {
    // @match /(pre_dictionary.+?){4}/
    if (dictionary != null && dictionary.hasKey(x) && dictionary != d2) {
        return dictionary.get(x) as Number;
    } else {
        return null;
    }
}
