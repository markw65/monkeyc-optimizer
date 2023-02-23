import Toybox.Test;
import Toybox.Lang;
import Toybox.Math;
import Toybox.Application;

const NON_ZERO_CONST = 42;
const ZERO_CONST = 0;

var gLogger as Logger?;

(:test)
function testRelationalFolding1(logger as Logger) as Boolean {
    ok = true;
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

    /* @match /check\(@42, @42, logger\);/ */
    check(ZERO_CONST == 0 ? 42 : 24, 42, logger);
    /* @match /check\(@42, @42, logger\);/ */
    check(ZERO_CONST == 0l ? 42 : 24, 42, logger);
    /* @match /check\(@42, @42, logger\);/ */
    check(ZERO_CONST == 0f ? 42 : 24, 42, logger);
    /* @match /check\(@42, @42, logger\);/ */
    check(ZERO_CONST == 0d ? 42 : 24, 42, logger);

    /* @match /check\(@42, @42, logger\);/ */
    check(NON_ZERO_CONST == '*' ? 42 : 24, 42, logger);
    /* @match /check\(@42, @42, logger\);/ */
    check('*' == NON_ZERO_CONST ? 42 : 24, 42, logger);
    return ok;
}

(:test)
function testSymbolComparisonsExpectedFail4_1_6_4_2_0U(
    logger as Logger
) as Boolean {
    ok = true;
    /* @match /check\(@42, @42, logger\);/ */
    check(:foo == :foo ? 42 : 24, 42, logger);
    /* @match /check\(@24, @24, logger\);/ */
    check(:foo != :foo ? 42 : 24, 24, logger);

    return ok;
}

(:test,:typecheck(false))
function testRelationalFolding2(logger as Logger) as Boolean {
    ok = true;

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
    var x = logger != gLogger;
    /* @match /check\(@0, @0, logger\);/ */
    check(NON_ZERO_CONST == 0 && ZERO_CONST == 0 ? 42 : 0, 0, logger);
    /* @match /check\(@0, @0, logger\);/ */
    check(NON_ZERO_CONST == 0 && logger != gLogger ? 42 : 0, 0, logger);
    /* @match /check\(logger != @gLogger \? @42 : @0, @42, logger\);/ */
    check(NON_ZERO_CONST != 0 && logger != gLogger ? 42 : 0, 42, logger);
    /* @match "check(x ?" */
    check(NON_ZERO_CONST != 0 && x ? 42 : 0, 42, logger);
    // prettier-ignore
    /* @match /check\(\(x as Boolean\) \? @42 : @0/ */
    check(NON_ZERO_CONST != 0 && (x as Boolean) ? 42 : 0, 42, logger);

    /* @match /check\(@42, @42, logger\);/ */
    check(NON_ZERO_CONST != 0 || ZERO_CONST == 0 ? 42 : 0, 42, logger);
    /* @match /check\(@42, @42, logger\);/ */
    check(NON_ZERO_CONST != 0 || logger != gLogger ? 42 : 0, 42, logger);
    /* @match /check\(logger != @gLogger \? @42 : @0, @42, logger\);/ */
    check(NON_ZERO_CONST == 0 || logger != gLogger ? 42 : 0, 42, logger);
    /* @match "check(x ?" */
    check(NON_ZERO_CONST == 0 || x ? 42 : 0, 42, logger);
    // prettier-ignore
    /* @match /check\(\(x as Boolean\) \? @42 : @0/ */
    check(NON_ZERO_CONST == 0 || (x as Boolean) ? 42 : 0, 42, logger);

    /* @match /check\(logger != @gLogger \? @42 : @0, @42, logger\);/ */
    check(true and logger != gLogger ? 42 : 0, 42, logger);
    /* @match /check\(@0, @0, logger\);/ */
    check(false and logger != gLogger ? 42 : 0, 0, logger);
    /* @match /check\(@42, @42, logger\);/ */
    check(true or logger != gLogger ? 42 : 0, 42, logger);
    /* @match /check\(logger != @gLogger \? @42 : @0, @42, logger\);/ */
    check(false or logger != gLogger ? 42 : 0, 42, logger);
    return ok;
}

(:test,:typecheck(false))
function testLogicalFoldingNonTypeSafe(logger as Logger) as Boolean {
    ok = true;
    var x = logger != gLogger;
    /* @match /check\(42, 42, logger\);/ */
    check((ZERO_CONST && x) == 0 ? 42 : 0, 42, logger);
    /* @match /check\(0, 0, logger\);/ */
    check((NON_ZERO_CONST || x) == 42 ? 0 : 42, 0, logger);
    return ok;
}

(:typecheck(false))
function add(
    logger as Logger,
    a as Number or Long or Float or Double or String or Char or Null,
    b as Number or Long or Float or Double or String or Char or Null,
    c as Number or Long or Float or Double or String or Char
) as Void {
    check(c, a + b, logger);
}

var xGlobal as Number = 42;
var yGlobal as Number = 24;
(:test)
function testAddFolding(logger as Logger) as Boolean {
    ok = true;
    add(logger, 1, 41, /* @match /^@42$/ */ 1 + 41);
    add(logger, 1.5, 41, /* @match /^@42.5$/ */ 1.5 + 41);
    add(logger, 1.5, 41l, /* @match /^@42.5d$/ */ 1.5 + 41l);
    add(logger, 1.5d, 41, /* @match /^@42.5d$/ */ 1.5d + 41l);

    add(logger, null, "foo", /* @match "nullfoo" */ null + "foo");
    add(logger, 1, "foo", /* @match "1foo" */ 1 + "foo");
    add(logger, 1l, "foo", /* @match "1foo" */ 1l + "foo");
    add(logger, "foo", 'a', /* @match "fooa" */ "foo" + 'a');
    add(logger, 1, 'a', /* @match "'b'" */ 1 + 'a');
    // null + 'a' and 'a' + null are errors

    // skip these because we don't know what precision to use when
    // converting the float to a string; and because garmin isn't
    // even consistent about that precision. See
    // https://forums.garmin.com/developer/connect-iq/i/bug-reports/sdk-4-1-7-constant-folds-floats-strings-incorrectly

    // add(logger, 1.1, "foo", /* @match /@1.1 \+ @"foo"/ */ 1.1 + "foo");
    // add(logger, 1.2d, "foo", /* @match /@1.2d \+ @"foo"/ */ 1.2d + "foo");

    add(logger, "foo", null, /* @match "foonull" */ "foo" + null);
    add(logger, "foo", 1, /* @match "foo1" */ "foo" + 1);
    add(logger, "foo", 1l, /* @match "foo1" */ "foo" + 1l);
    add(logger, 'a', "foo", /* @match "afoo" */ 'a' + "foo");
    add(logger, 'a', 1, /* @match "'b'" */ 'a' + 1);
    // skip these as above
    // add(logger, "foo", 1.1, /* @match /@"foo" \+ @1.1/ */ "foo" + 1.1);
    // add(logger, "foo", 1.2d, /* @match /@"foo" \+ @1.2d/ */ "foo" + 1.2d);

    add(
        logger,
        xGlobal + 1,
        yGlobal + 2,
        /* @match /^@xGlobal \+ @yGlobal \+ @3$/ */ xGlobal + 1 + (yGlobal + 2)
    );
    add(
        logger,
        xGlobal + 1,
        yGlobal - 2,
        /* @match /^@xGlobal \+ @yGlobal \+ @-1$/ */ xGlobal + 1 + (yGlobal - 2)
    );
    add(
        logger,
        xGlobal - 1,
        yGlobal + 2,
        /* @match /^@xGlobal \+ @yGlobal - @-1$/ */ xGlobal - 1 + (yGlobal + 2)
    );
    add(
        logger,
        xGlobal - 1,
        yGlobal - 2,
        /* @match /^@xGlobal \+ @yGlobal - @3$/ */ xGlobal - 1 + (yGlobal - 2)
    );
    return ok;
}

function sub(
    logger as Logger,
    a as Number or Long or Float or Double,
    b as Number or Long or Float or Double,
    c as Number or Long or Float or Double
) as Void {
    check(c, a - b, logger);
}

(:test)
function testSubFolding(logger as Logger) as Boolean {
    ok = true;
    sub(logger, 1, 41, /* @match /^@-40$/ */ 1 - 41);
    sub(logger, 1.5, 41, /* @match /^@-39.5$/ */ 1.5 - 41);
    sub(logger, 1.5, 41l, /* @match /^@-39.5d$/ */ 1.5 - 41l);
    sub(logger, 1.5d, 41, /* @match /^@-39.5d$/ */ 1.5d - 41l);

    sub(logger, 1.5, 0.5, /* @match /^@1f$/ */ 1.5 - 0.5);
    sub(logger, 1.5d, 0.5, /* @match /^@1d$/ */ 1.5d - 0.5);
    sub(logger, 1.5, 0.5d, /* @match /^@1d$/ */ 1.5 - 0.5d);
    sub(logger, 1.5d, 0.5d, /* @match /^@1d$/ */ 1.5d - 0.5d);

    sub(
        logger,
        xGlobal + 1,
        yGlobal + 2,
        /* @match /^@xGlobal - @yGlobal \+ @-1$/ */ xGlobal + 1 - (yGlobal + 2)
    );
    sub(
        logger,
        xGlobal + 1,
        yGlobal - 2,
        /* @match /^@xGlobal - @yGlobal \+ @3$/ */ xGlobal + 1 - (yGlobal - 2)
    );
    sub(
        logger,
        xGlobal - 1,
        yGlobal + 2,
        /* @match /^@xGlobal - @yGlobal - @3$/ */ xGlobal - 1 - (yGlobal + 2)
    );
    sub(
        logger,
        xGlobal - 1,
        yGlobal - 2,
        /* @match /^@xGlobal - @yGlobal - @-1$/ */ xGlobal - 1 - (yGlobal - 2)
    );
    return ok;
}

function mul(
    logger as Logger,
    a as Number or Long or Float or Double,
    b as Number or Long or Float or Double,
    c as Number or Long or Float or Double
) as Void {
    check(c, a * b, logger);
}

(:test)
function testMulFolding(logger as Logger) as Boolean {
    ok = true;
    mul(logger, 2, 41, /* @match /^@82$/ */ 2 * 41);
    mul(logger, 1.5, 42, /* @match /^@63f$/ */ 1.5 * 42);
    mul(logger, 1.5, 42l, /* @match /^@63d$/ */ 1.5 * 42l);
    mul(logger, 1.5d, 42, /* @match /^@63d$/ */ 1.5d * 42);

    mul(logger, 1.5, 0.5, /* @match /^@0.75$/ */ 1.5 * 0.5);
    mul(logger, 1.5d, 0.5, /* @match /^@0.75d$/ */ 1.5d * 0.5);
    mul(logger, 1.5, 0.5d, /* @match /^@0.75d$/ */ 1.5 * 0.5d);
    mul(logger, 1.5d, 0.5d, /* @match /^@0.75d$/ */ 1.5d * 0.5d);
    return ok;
}

function div(
    logger as Logger,
    a as Number or Long or Float or Double,
    b as Number or Long or Float or Double,
    c as Number or Long or Float or Double
) as Void {
    check(c, a / b, logger);
}

(:test)
function testDivFolding(logger as Logger) as Boolean {
    ok = true;
    div(logger, 55, 2, /* @match /^@27$/ */ 55 / 2);
    div(logger, 55.0, 2, /* @match /^@27.5$/ */ 55.0 / 2);
    div(logger, 55.0, 2l, /* @match /^@27.5d$/ */ 55.0 / 2l);
    div(logger, 55d, 2, /* @match /^@27.5d$/ */ 55d / 2);

    div(logger, 1.5, 0.5, /* @match /^@3f$/ */ 1.5 / 0.5);
    div(logger, 1.5d, 0.5, /* @match /^@3d$/ */ 1.5d / 0.5);
    div(logger, 1.5, 0.5d, /* @match /^@3d$/ */ 1.5 / 0.5d);
    div(logger, 1.5d, 0.5d, /* @match /^@3d$/ */ 1.5d / 0.5d);
    div(logger, Math.PI, 180, Math.PI / 180);
    return ok;
}

function mod(
    logger as Logger,
    a as Number or Long,
    b as Number or Long,
    c as Number or Long
) as Void {
    check(c, a % b, logger);
}

(:test)
function testModFolding(logger as Logger) as Boolean {
    ok = true;
    mod(logger, 55, 4, /* @match /^@3$/ */ 55 % 4);
    mod(logger, 55l, 4, /* @match /^@3l$/ */ 55l % 4);
    mod(logger, 55, 4l, /* @match /^@3l$/ */ 55 % 4l);
    mod(logger, 55l, 4l, /* @match /^@3l$/ */ 55l % 4l);

    return ok;
}

function band(
    logger as Logger,
    a as Number or Long,
    b as Number or Long,
    c as Number or Long
) as Void {
    check(c, a & b, logger);
}

(:test)
function testAndFolding(logger as Logger) as Boolean {
    ok = true;
    band(logger, 0x7e, 0x55, /* @match /^@84$/ */ 0x7e & 0x55);
    band(logger, 0x7el, 0x55, /* @match /^@84l$/ */ 0x7el & 0x55);
    band(logger, 0x7e, 0x55l, /* @match /^@84l$/ */ 0x7e & 0x55l);
    band(logger, 0x7el, 0x55l, /* @match /^@84l$/ */ 0x7el & 0x55l);

    return ok;
}

function bor(
    logger as Logger,
    a as Number or Long,
    b as Number or Long,
    c as Number or Long
) as Void {
    check(c, a | b, logger);
}

(:test)
function testOrFolding(logger as Logger) as Boolean {
    ok = true;
    bor(logger, 0x22, 0x55, /* @match /^@119$/ */ 0x22 | 0x55);
    bor(logger, 0x22l, 0x55, /* @match /^@119l$/ */ 0x22l | 0x55);
    bor(logger, 0x22, 0x55l, /* @match /^@119l$/ */ 0x22 | 0x55l);
    bor(logger, 0x22l, 0x55l, /* @match /^@119l$/ */ 0x22l | 0x55l);

    return ok;
}

function bxor(
    logger as Logger,
    a as Number or Long,
    b as Number or Long,
    c as Number or Long
) as Void {
    check(c, a ^ b, logger);
}

(:test)
function testXorFolding(logger as Logger) as Boolean {
    ok = true;
    bxor(logger, 0x7e, 0x55, /* @match /^@43$/ */ 0x7e ^ 0x55);
    bxor(logger, 0x7el, 0x55, /* @match /^@43l$/ */ 0x7el ^ 0x55);
    bxor(logger, 0x7e, 0x55l, /* @match /^@43l$/ */ 0x7e ^ 0x55l);
    bxor(logger, 0x7el, 0x55l, /* @match /^@43l$/ */ 0x7el ^ 0x55l);

    return ok;
}

function shl(
    logger as Logger,
    a as Number or Long,
    b as Number or Long,
    c as Number or Long
) as Void {
    check(c, a << b, logger);
}

(:test)
function testShlFolding(logger as Logger) as Boolean {
    ok = true;
    shl(logger, 0x7e, 8, /* @match /^@32256$/ */ 0x7e << 8);
    shl(logger, 0x7el, 8, /* @match /^@32256l$/ */ 0x7el << 8);
    shl(logger, 0x7e, 8l, /* @match /^@32256l$/ */ 0x7e << 8l);
    shl(logger, 0x7el, 8l, /* @match /^@32256l$/ */ 0x7el << 8l);

    return ok;
}

function shr(
    logger as Logger,
    a as Number or Long,
    b as Number or Long,
    c as Number or Long
) as Void {
    check(c, a >> b, logger);
}

(:test)
function testShrFolding(logger as Logger) as Boolean {
    ok = true;
    shr(logger, 0x7e00, 8, /* @match /^@126$/ */ 0x7e00 >> 8);
    shr(logger, 0x7e00l, 8, /* @match /^@126l$/ */ 0x7e00l >> 8);
    shr(logger, 0x7e00, 8l, /* @match /^@126l$/ */ 0x7e00 >> 8l);
    shr(logger, 0x7e00l, 8l, /* @match /^@126l$/ */ 0x7e00l >> 8l);

    return ok;
}

(:test)
function testIfFolding(logger as Logger) as Boolean {
    var x = logger != gLogger;
    /* @match /if \((x|logger != gLogger)\) \{/ */
    if (!x) {
        logger.debug("Nope");
        return false;
    } else if (x) {
        logger.debug("Yes");
        return true;
    }
    return false;
}

function mwrap(v as Numeric) as Numeric {
    v += wrapper(0);
    return v;
}

function mcheck(x as Numeric, expected as Numeric, logger as Logger) as Void {
    checker(x, expected, logger, true);
}

(:test)
function testMathFolding(logger as Logger) as Boolean {
    ok = true;
    A.B.x = 0;
    mcheck(Math.acos(0), Math.acos(mwrap(0)), logger);
    A.B.x = 1;
    mcheck(Math.asin(1), Math.asin(mwrap(1)), logger);
    A.B.x = 2;
    mcheck(Math.atan(42), Math.atan(mwrap(42)), logger);
    A.B.x = 3;
    mcheck(Math.atan2(42, 42), Math.atan2(mwrap(42), mwrap(42)), logger);
    A.B.x = 4;
    mcheck(Math.ceil(42), Math.ceil(mwrap(42)), logger);
    A.B.x = 5;
    mcheck(Math.cos(42), Math.cos(mwrap(42)), logger);
    A.B.x = 6;
    mcheck(Math.floor(42), Math.floor(mwrap(42)), logger);
    A.B.x = 7;
    mcheck(Math.log(42, 12), Math.log(mwrap(42), 12), logger);
    A.B.x = 8;
    mcheck(Math.pow(2, 42), Math.pow(mwrap(2), mwrap(42)), logger);
    A.B.x = 9;
    mcheck(Math.round(42), Math.round(mwrap(42)), logger);
    A.B.x = 10;
    mcheck(Math.sin(42), Math.sin(mwrap(42)), logger);
    A.B.x = 11;
    mcheck(Math.sqrt(42), Math.sqrt(mwrap(42)), logger);
    A.B.x = 12;
    mcheck(Math.tan(42), Math.tan(mwrap(42)), logger);
    A.B.x = 13;
    mcheck(Math.toDegrees(42), Math.toDegrees(mwrap(42)), logger);
    A.B.x = 14;
    mcheck(Math.toRadians(42), Math.toRadians(mwrap(42)), logger);

    A.B.x = 15;
    mcheck(Math.acos(0l), Math.acos(mwrap(0l)), logger);
    A.B.x = 16;
    mcheck(Math.asin(1l), Math.asin(mwrap(1l)), logger);
    A.B.x = 17;
    mcheck(Math.atan(42l), Math.atan(mwrap(42l)), logger);
    A.B.x = 18;
    mcheck(Math.atan2(42l, 42l), Math.atan2(mwrap(42l), mwrap(42l)), logger);
    A.B.x = 19;
    mcheck(Math.ceil(42l), Math.ceil(mwrap(42l)), logger);
    A.B.x = 20;
    mcheck(Math.cos(42l), Math.cos(mwrap(42l)), logger);
    A.B.x = 21;
    mcheck(Math.floor(42l), Math.floor(mwrap(42l)), logger);
    A.B.x = 22;
    mcheck(Math.log(42l, 12l), Math.log(mwrap(42l), 12l), logger);
    A.B.x = 23;
    mcheck(Math.pow(2l, 42l), Math.pow(mwrap(2l), mwrap(42l)), logger);
    A.B.x = 24;
    mcheck(Math.round(42l), Math.round(mwrap(42l)), logger);
    A.B.x = 25;
    mcheck(Math.sin(42l), Math.sin(mwrap(42l)), logger);
    A.B.x = 26;
    mcheck(Math.sqrt(42l), Math.sqrt(mwrap(42l)), logger);
    A.B.x = 27;
    mcheck(Math.tan(42l), Math.tan(mwrap(42l)), logger);
    A.B.x = 28;
    mcheck(Math.toDegrees(42l), Math.toDegrees(mwrap(42l)), logger);
    A.B.x = 29;
    mcheck(Math.toRadians(42l), Math.toRadians(mwrap(42l)), logger);

    A.B.x = 30;
    mcheck(Math.acos(0.5), Math.acos(mwrap(0.5)), logger);
    A.B.x = 31;
    mcheck(Math.asin(0.5), Math.asin(mwrap(0.5)), logger);
    A.B.x = 32;
    mcheck(Math.atan(0.42), Math.atan(mwrap(0.42)), logger);
    A.B.x = 33;
    mcheck(Math.atan2(4.2, 4.2), Math.atan2(mwrap(4.2), mwrap(4.2)), logger);
    A.B.x = 34;
    mcheck(Math.ceil(4.2), Math.ceil(mwrap(4.2)), logger);
    A.B.x = 35;
    mcheck(Math.cos(0.42), Math.cos(mwrap(0.42)), logger);
    A.B.x = 36;
    mcheck(Math.floor(4.2), Math.floor(mwrap(4.2)), logger);
    A.B.x = 37;
    mcheck(Math.log(4.2, 12), Math.log(mwrap(4.2), 12), logger);
    A.B.x = 38;
    mcheck(Math.pow(2.0, 4.2), Math.pow(mwrap(2.0), mwrap(4.2)), logger);
    A.B.x = 39;
    mcheck(Math.round(4.2), Math.round(mwrap(4.2)), logger);
    A.B.x = 40;
    mcheck(Math.sin(0.42), Math.sin(mwrap(0.42)), logger);
    A.B.x = 41;
    mcheck(Math.sqrt(0.42), Math.sqrt(mwrap(0.42)), logger);
    A.B.x = 42;
    mcheck(Math.tan(0.42), Math.tan(mwrap(0.42)), logger);
    A.B.x = 43;
    mcheck(Math.toDegrees(4.2), Math.toDegrees(mwrap(4.2)), logger);
    A.B.x = 44;
    mcheck(Math.toRadians(4.2), Math.toRadians(mwrap(4.2)), logger);

    A.B.x = 45;
    mcheck(Math.acos(0.5d), Math.acos(mwrap(0.5d)), logger);
    A.B.x = 46;
    mcheck(Math.asin(0.5d), Math.asin(mwrap(0.5d)), logger);
    A.B.x = 47;
    mcheck(Math.atan(4.2d), Math.atan(mwrap(4.2d)), logger);
    A.B.x = 48;
    mcheck(
        Math.atan2(4.2d, 4.2d),
        Math.atan2(mwrap(4.2d), mwrap(4.2d)),
        logger
    );
    A.B.x = 49;
    mcheck(Math.ceil(4.2d), Math.ceil(mwrap(4.2d)), logger);
    A.B.x = 50;
    mcheck(Math.cos(0.42d), Math.cos(mwrap(0.42d)), logger);
    A.B.x = 51;
    mcheck(Math.floor(4.2d), Math.floor(mwrap(4.2d)), logger);
    A.B.x = 52;
    mcheck(Math.log(4.2d, 12), Math.log(mwrap(4.2d), 12), logger);
    A.B.x = 53;
    mcheck(Math.pow(2.0d, 4.2d), Math.pow(mwrap(2.0d), mwrap(4.2d)), logger);
    A.B.x = 54;
    mcheck(Math.round(4.2d), Math.round(mwrap(4.2d)), logger);
    A.B.x = 55;
    mcheck(Math.sin(0.42d), Math.sin(mwrap(0.42d)), logger);
    A.B.x = 56;
    mcheck(Math.sqrt(4.2d), Math.sqrt(mwrap(4.2d)), logger);
    A.B.x = 57;
    mcheck(Math.tan(0.42d), Math.tan(mwrap(0.42d)), logger);
    A.B.x = 58;
    mcheck(Math.toDegrees(4.2d), Math.toDegrees(mwrap(4.2d)), logger);
    A.B.x = 59;
    mcheck(Math.toRadians(4.2d), Math.toRadians(mwrap(4.2d)), logger);

    if (Math has :ln) {
        A.B.x = 60;
        mcheck(Math.ln(42), Math.ln(mwrap(42)), logger);
        A.B.x = 61;
        mcheck(Math.ln(42l), Math.ln(mwrap(42l)), logger);
        A.B.x = 62;
        mcheck(Math.ln(4.2), Math.ln(mwrap(4.2)), logger);
        A.B.x = 63;
        mcheck(Math.ln(4.2d), Math.ln(mwrap(4.2d)), logger);
    }
    return ok;
}

function argChecker(x as Array<Number>?) as Void {}

const HR_ZONES_MOCK = null as Array<Number>?;
const MY_NUMBER = 4 as Number?;

(:test)
function constantsWithCasts(logger as Logger) as Boolean {
    // @match "return true;"
    if (gMaybeModified != 0 && HR_ZONES_MOCK != null) {
        argChecker(HR_ZONES_MOCK);
    }
    if (MY_NUMBER != 4) {
        return false;
    }
    return true;
}

typedef RecursiveArray as Array<Number or RecursiveArray>;
(:test)
function recursiveArray(logger as Logger) as Boolean {
    var x = [1] as RecursiveArray;
    for (var i = 0; i < 10; i++) {
        if (i & 1) {
            x.add(i);
        } else {
            x = [x] as RecursiveArray;
        }
    }

    return x[1] == 9;
}

(:test,:typecheck(false))
function recursiveArrayInferred(logger as Logger) as Boolean {
    var x = [1];
    for (var i = 0; i < 10; i++) {
        if (i & 1) {
            x.add(i);
        } else {
            x = [x];
        }
    }

    return x[1] == 9;
}

class Other {
    var value as Number = 0;
}

function hide(x as Whatever, y as Whatever) as Whatever {
    return x.value >= y.value ? x : y;
}

class Whatever {
    var value as Number = 0;
    var what as Whatever? = null;
    var other as Other? = null;

    (:typecheck(false))
    function test(logger as Logger) as Boolean {
        ok = true;
        var x = new Whatever();
        var o = new Other();
        x.other = o;
        var z = hide(x, self); // z = x
        var y = hide(self, x); // y = self
        x.what = z;

        // x.value might be the same as z.value
        // so we shouldn't const prop x.value
        x.value = 42;
        z.value = 1;
        // @match /check\(x.value, @1/
        check(x.value, 1, logger);

        // x.value can't be the same as o.value
        // so we should const prop x.value
        x.value = 42;
        o.value = 1;
        // @match /check\(@42, @42/
        check(x.value, 42, logger);

        // x.value might be the same as x.what.value
        // so we shouldn't const prop x.value
        x.value = 42;
        x.what.value = 1;
        // @match /check\(x.value, @1/
        check(x.value, 1, logger);

        // x.value can't be the same as x.other.value
        // so we should const prop x.value
        x.value = 42;
        x.other.value = 1;
        // @match /check\(@42, @42/
        check(x.value, 42, logger);

        // x.value might be the same as x.what.value
        // so we shouldn't const prop x.what.value
        x.what.value = 1;
        x.value = 42;
        // @match /check\(x.what.value, @42/
        check(x.what.value, 42, logger);

        // x.value can't be the same as x.other.value
        // so we should const prop x.other.value
        x.other.value = 1;
        x.value = 42;
        // @match /check\(@1, @1/
        check(x.other.value, 1, logger);

        // y.value might be the same as self.value
        // so we shouldn't const prop y.value
        y.value = 42;
        value = 1;
        // @match /check\(y.value, @1/
        check(y.value, 1, logger);

        // x.other.value can't be the same as self.value
        // so we should const prop x.other.value
        x.other.value = 42;
        value = 1;
        // @match /check\(@42, @42/
        check(x.other.value, 42, logger);

        // y.value might be the same as self.value
        // so we shouldn't const prop self.value
        value = 42;
        y.value = 1;
        // @match /check\(value, @1/
        check(value, 1, logger);

        // x.other.value can't be the same as self.value
        // so we should const prop self.value
        value = 1;
        x.other.value = 42;
        // @match /check\(@1, @1/
        check(value, 1, logger);

        return ok;
    }
}

(:test,:typecheck(false))
function testMemberDecl(logger as Logger) as Boolean {
    return (new Whatever()).test(logger);
}

(:test)
function testInstanceofFolding(logger as Logger) as Boolean {
    var x = 42;
    if (gMaybeModified != x) {
        x = logger;
    }
    if (x instanceof Lang.Number) {
        return x == 42;
    } else {
        /* @match /^return / */
        if (x instanceof Test.Logger) {
            return x == logger;
        } else {
            return false;
        }
    }

}

(:inline)
function toBool1(
    value as PropertyValueType?,
    defaultValue as Boolean
) as Boolean {
    return value instanceof Lang.Boolean
        ? value
        : value != null && value has :toNumber
        ? value.toNumber() != 0
        : defaultValue;
}

(:inline)
function toBool2(
    value as PropertyValueType?,
    defaultValue as Boolean
) as Boolean {
    if (value instanceof Lang.Boolean) {
        return value;
    }
    if (value != null && value has :toNumber) {
        return value.toNumber() != 0;
    }
    return defaultValue;
}

(:test)
function toBoolTest(logger as Logger) as Boolean {
    if (!toBool1(null, true)) {
        return false;
    }
    if (!toBool2(null, true)) {
        return false;
    }
    return toBool1(42, false);
}
