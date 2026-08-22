// source/Repro.mc
import Toybox.Lang;
import Toybox.Activity;

const FIT_GENERIC = 0;

(:keep)
function reproPick() as Array<Number> {
    return [
        Activity has :SPORT_GENERIC ? Activity.SPORT_GENERIC : FIT_GENERIC,
        Activity has :SUB_SPORT_GENERIC
            ? Activity.SUB_SPORT_GENERIC
            : FIT_GENERIC,
    ];
}
