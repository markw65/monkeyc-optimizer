import Toybox.Lang;
import Toybox.Application;
import Toybox.Application.Storage;
import A.B;

(:inline)
function inlineNeedsLocalImport() as Number {
    return B.a();
}

(:inline)
function inlineNeedsToyboxImport() as PropertyValueType {
    return Application has :Storage ? Storage.getValue("a") : null;
}
