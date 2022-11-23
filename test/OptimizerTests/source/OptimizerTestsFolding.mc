import Toybox.Test;
import Toybox.Lang;

const NON_ZERO_CONST = 42;
const ZERO_CONST = 0;
(:test)
function testRelationalFolding1(logger as Logger) as Boolean {
    ok = true;
    var x = logger != null;
    /* @match /check\(@24, @24, logger\);/ */
    check(NON_ZERO_CONST == ZERO_CONST ? 42 : 24, 24, logger);
    /* @match /check\(@42, @42, logger\);/ */
    check(ZERO_CONST == ZERO_CONST ? 42 : 24, 42, logger);
    /* @match /check\(@24, @24, logger\);/ */
    check(ZERO_CONST == NON_ZERO_CONST ? 42 : 24, 24, logger);

    /* @match /check\(@42, @42, logger\);/ */
    check(NON_ZERO_CONST != ZERO_CONST ? 42 : 24, 42, logger);
    /* @match /check\(@24, @24, logger\);/ */
    check(ZERO_CONST != ZERO_CONST ? 42 : 24, 24, logger);
    /* @match /check\(@42, @42, logger\);/ */
    check(ZERO_CONST != NON_ZERO_CONST ? 42 : 24, 42, logger);

    /* @match /check\(@24, @24, logger\);/ */
    check(NON_ZERO_CONST <= ZERO_CONST ? 42 : 24, 24, logger);
    /* @match /check\(@42, @42, logger\);/ */
    check(NON_ZERO_CONST <= NON_ZERO_CONST ? 42 : 24, 42, logger);
    /* @match /check\(@42, @42, logger\);/ */
    check(ZERO_CONST <= NON_ZERO_CONST ? 42 : 24, 42, logger);

    /* @match /check\(@24, @24, logger\);/ */
    check(NON_ZERO_CONST < ZERO_CONST ? 42 : 24, 24, logger);
    /* @match /check\(@24, @24, logger\);/ */
    check(NON_ZERO_CONST < NON_ZERO_CONST ? 42 : 24, 24, logger);
    /* @match /check\(@42, @42, logger\);/ */
    check(ZERO_CONST < NON_ZERO_CONST ? 42 : 24, 42, logger);

    /* @match /check\(@42, @42, logger\);/ */
    check(NON_ZERO_CONST >= ZERO_CONST ? 42 : 24, 42, logger);
    /* @match /check\(@42, @42, logger\);/ */
    check(NON_ZERO_CONST >= NON_ZERO_CONST ? 42 : 24, 42, logger);
    /* @match /check\(@24, @24, logger\);/ */
    check(ZERO_CONST >= NON_ZERO_CONST ? 42 : 24, 24, logger);

    /* @match /check\(@42, @42, logger\);/ */
    check(NON_ZERO_CONST > ZERO_CONST ? 42 : 24, 42, logger);
    /* @match /check\(@24, @24, logger\);/ */
    check(NON_ZERO_CONST > NON_ZERO_CONST ? 42 : 24, 24, logger);
    /* @match /check\(@24, @24, logger\);/ */
    check(ZERO_CONST > NON_ZERO_CONST ? 42 : 24, 24, logger);
    return ok;
}

(:test,:typecheck(false))
function testRelationalFolding2(logger as Logger) as Boolean {
    ok = true;
    var x = logger != null;

    /* @match /check\(@24, @24, logger\);/ */
    check(false == NON_ZERO_CONST ? 42 : 24, 24, logger);
    /* @match /check\(@24, @24, logger\);/ */
    check(null == NON_ZERO_CONST ? 42 : 24, 24, logger);
    /* @match /check\(@42, @42, logger\);/ */
    check(false != NON_ZERO_CONST ? 42 : 24, 42, logger);
    /* @match /check\(@42, @42, logger\);/ */
    check(null != NON_ZERO_CONST ? 42 : 24, 42, logger);

    return ok;
}

(:test)
function testLogicalFolding(logger as Logger) as Boolean {
    ok = true;
    var x = logger != null;
    /* @match /check\(@0, @0, logger\);/ */
    check(NON_ZERO_CONST == 0 && ZERO_CONST == 0 ? 42 : 0, 0, logger);
    /* @match /check\(@0, @0, logger\);/ */
    check(NON_ZERO_CONST == 0 && logger != null ? 42 : 0, 0, logger);
    /* @match /check\(logger != null \? @42 : @0, @42, logger\);/ */
    check(NON_ZERO_CONST != 0 && logger != null ? 42 : 0, 42, logger);
    /* @match "check(true && x" */
    check(NON_ZERO_CONST != 0 && x ? 42 : 0, 42, logger);
    // prettier-ignore
    /* @match /check\(\(x as Boolean\) \? @42 : @0/ */
    check(NON_ZERO_CONST != 0 && (x as Boolean) ? 42 : 0, 42, logger);

    /* @match /check\(@42, @42, logger\);/ */
    check(NON_ZERO_CONST != 0 || ZERO_CONST == 0 ? 42 : 0, 42, logger);
    /* @match /check\(@42, @42, logger\);/ */
    check(NON_ZERO_CONST != 0 || logger != null ? 42 : 0, 42, logger);
    /* @match /check\(logger != null \? @42 : @0, @42, logger\);/ */
    check(NON_ZERO_CONST == 0 || logger != null ? 42 : 0, 42, logger);
    /* @match "check(false || x" */
    check(NON_ZERO_CONST == 0 || x ? 42 : 0, 42, logger);
    // prettier-ignore
    /* @match /check\(\(x as Boolean\) \? @42 : @0/ */
    check(NON_ZERO_CONST == 0 || (x as Boolean) ? 42 : 0, 42, logger);

    /* @match /check\(logger != null \? @42 : @0, @42, logger\);/ */
    check(true and logger != null ? 42 : 0, 42, logger);
    /* @match /check\(@0, @0, logger\);/ */
    check(false and logger != null ? 42 : 0, 0, logger);
    /* @match /check\(@42, @42, logger\);/ */
    check(true or logger != null ? 42 : 0, 42, logger);
    /* @match /check\(logger != null \? @42 : @0, @42, logger\);/ */
    check(false or logger != null ? 42 : 0, 42, logger);
    return ok;
}

(:test,:typecheck(false))
function testLogicalFoldingNonTypeSafe(logger as Logger) as Boolean {
    ok = true;
    var x = logger != null;
    /* @match /check\(42, 42, logger\);/ */
    check((ZERO_CONST && x) == 0 ? 42 : 0, 42, logger);
    /* @match /check\(0, 0, logger\);/ */
    check((NON_ZERO_CONST || x) == 42 ? 0 : 42, 0, logger);
    return ok;
}
