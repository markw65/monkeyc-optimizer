import Toybox.Lang;

function bad(value as Boolean or Number) as Number {
    if (value instanceof Lang.Boolean) {
        return value ? 0 : -1;
    } else {
        return value + 2;
    }
}
