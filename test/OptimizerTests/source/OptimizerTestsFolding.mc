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

(:typecheck(false))
function add(
    logger as Logger,
    a as Number or Long or Float or Double or String or Char or Null,
    b as Number or Long or Float or Double or String or Char or Null,
    c as Number or Long or Float or Double or String or Char
) as Void {
    check(c, a + b, logger);
}

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
