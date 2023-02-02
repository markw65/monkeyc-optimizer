import Toybox.Lang;
import Toybox.Test;
import Toybox.Application;
import Toybox.Application.Storage;
import Toybox.WatchUi;
import A.B;

(:inline)
function inlineNeedsLocalImport() as Number {
    return B.a();
}

(:inline)
function inlineNeedsToyboxImport() as PropertyValueType {
    return Application has :Storage ? Storage.getValue("a") : null;
}

(:typecheck(false))
function noSystem() as Void {
    // Fails at runtime: "Could not find symbol 'System'"
    /* @expect "Undefined symbol System.println" */
    System.println(0);
}

function noNumber(x as Number or String) as Boolean {
    // Fails at runtime: "Could not find symbol 'Number'"
    /* @expect "Number will only be found" */
    return x instanceof Number;
}

function properties() as Void {
    /* @expect "Properties will only be found" */
    Properties.getValue("What");
}

class Dictionary {
}

module X {
    const XCONSTANT = 0;
    module Y {
        const YCONSTANT = 1;
        class Base {
            const BCONSTANT = 0;
        }
    }
    module Z {
        const ZCONSTANT = 2;
    }
}
class TestClass extends X.Y.Base {
    function initialize() {
        Base.initialize();
    }
    const FOO as Number = ENDIAN_BIG as Number;
    function noSystem() as Void {
        // works!
        System.println(Communications.UNKNOWN_ERROR as Number);
    }
    function noNumber(
        x as Number or String or Dictionary or Lang.Dictionary or Array
    ) as Number {
        // works!
        return (
            (x instanceof Number ? ENDIAN_BIG : ENDIAN_LITTLE) +
            (x instanceof String ? YCONSTANT : XCONSTANT) +
            (x instanceof Object ? Z.ZCONSTANT : 0) +
            (x instanceof Dictionary ? 1 : 0) +
            (x instanceof Array ? 1 : 0)
        );
    }
    static function noNumberStatic(x as Number or String) as Boolean {
        // Fails at runtime: "Could not find symbol 'Number'"
        /* @expect "Number will only be found" */
        var t = x instanceof Number;
        return t;
    }
    function properties() as Void {
        /* @expect "Properties will only be found" */
        Properties.getValue("What");
    }
}

(:test)
function lookupTestsWorking(logger as Logger) as Boolean {
    logger.debug(TestClass.FOO == null ? "Null" : "ERROR");
    var x = new TestClass();
    logger.debug(x.FOO.toString());
    x.noSystem();
    logger.debug(x.noNumber(1).toString());
    logger.debug(x.noNumber(new $.Dictionary()).toString());
    logger.debug(x.noNumber({ "a" => "b" }).toString());
    return true;
}

(:test,:typecheck(false))
function lookupInOuterScope(logger as Logger) as Boolean {
    ok = true;
    check(X.Y.XCONSTANT, 0, logger);
    check($.X.Y.XCONSTANT, 0, logger);
    return ok;
}

(:test)
function lookupTest1Crash(logger as Logger) as Boolean {
    noSystem();
    return false;
}
(:test)
function lookupTest2Crash(logger as Logger) as Boolean {
    $.Toybox.System.println(noNumber(1));
    // prior to compiler 2, noNumber crashes
    // afterwards, its fine
    return true;
}
(:test)
function lookupTest3Crash(logger as Logger) as Boolean {
    $.Toybox.System.println(TestClass.noNumberStatic(1));
    // prior to compiler 2, noNumberStatic crashes
    // afterwards, its fine
    return true;
}
(:test)
function lookupTest4Crash(logger as Logger) as Boolean {
    $.properties();
    return false;
}
(:test)
function lookupTest5Crash(logger as Logger) as Boolean {
    var x = new TestClass();
    x.properties();
    return false;
}

/*
 * Check the superclass search order, which is weird
 *
 * The search order from within X should be:
 *  - Search X itself
 *  - Search B.Mid (the super class)
 *  - Search MA.Base (the super class's super class)
 *  - Search Toybox.Lang.Object (the implied super super super class)
 *  - Search outwards from X to the global module
 *  - Search outwards from Mid to the global module
 *  - Search outwards from Base to the global module
 *  - Search outwards from Object to the global module
 */
module MA {
    module B {
        const K1 = 2;
    }
    const FOOA = 1;
    const FOOB = 1;
    const FOOC = 1;
    var x as Symbol?;
    class Base {
        const SUPERA = 2;
        const SUPERB = 2;
        const SUPERC = 2;
        function initialize() {
            // don't let the compiler remove
            // checkUsingScope below.
            x = :checkUsingScope;
        }
    }
    // make sure checkUsingScope wasn't optimized away
    /* @match "checkUsingScope" */
    function checkUsingScope() as Number {
        // keep it from being optimized away
        methodArgsArentInvalidSymbols(null);
        // should find B via import A.B
        // not from MA.B above.
        /* @match "return 1;" */
        return B.K1;
    }

    // Make sure we don't report axxy, bxxy and cxxy as invalid symbols
    function methodArgsArentInvalidSymbols(
        m as Null or (Method(axxy as Number, bxxy as Number, cxxy) as Void)
    ) as Void {}
}

module MB {
    const FOOB = 3;
    const FOOC = 3;
    class Mid extends MA.Base {
        function initialize() {
            Base.initialize();
        }
        const SUPERB = 4;
        const SUPERC = 4;
    }
}

module MC {
    const FOOC = 5;
    class X extends MB.Mid {
        const SUPERC = 6;
        function initialize() {
            Mid.initialize();
            /* @match "(1)" */
            System.println(FOOA);
            /* @match "(3)" */
            System.println(FOOB);
            /* @match "(5)" */
            System.println(FOOC);
            /* @match "(2)" */
            System.println(SUPERA);
            /* @match "(4)" */
            System.println(SUPERB);
            /* @match "(6)" */
            System.println(SUPERC);
            /* @match "(1)" */
            System.println(B.K1);
        }
        class Y {
            (:typecheck(false))
            function initialize() {
                /* @expect "Undefined symbol FOOB" */
                System.println(FOOB);
                /* @expect "Undefined symbol SUPERB" */
                System.println(SUPERB);
                /* @expect "Undefined symbol FOOC" */
                System.println(FOOC);
                /* @expect "Undefined symbol SUPERC" */
                System.println(SUPERC);
                /* @expect "Undefined symbol Mid" */
                System.println(Mid.SUPERB);
            }
        }
    }
}

module Inheritance {
    class Base {
        hidden var h as Number = 1;
        private var p as Number = 1;
        (:inline)
        function badQualifier() as Number {
            var x = p;
            return x;
        }
        function foo() as Number {
            var p;
            /* @match /return self.p \+ 24;/ */
            p = badQualifier();
            return p + 24;
        }
    }
    class Child extends Base {
        (:inline)
        function localConflict() as Number {
            return h;
        }
        (:inline,:typecheck(false))
        function localPrivate() as Number {
            return p;
        }
        function bar() as Number {
            var h = 42;
            /* @match /self\.h \+ @42/ */
            return localConflict() + h;
        }
        (:typecheck(false))
        function baz() as Number {
            var p = 42;
            /* @match /self\.p \+ @42/ */
            return localPrivate() + p;
        }
    }
    (:test)
    function inherit(logger as Logger) as Boolean {
        var x = new Child();
        return x.bar() == 43 && x.foo() == 25;
    }
    (:test)
    function privateFromDerivedCrash(logger as Logger) as Boolean {
        var x = new Child();
        return x.baz() == 43;
    }
}

module Statics {
    var ok as Boolean = false;
    class C {
        private static var v1 as Boolean = false;
        private static const K1 = 42;

        function initialize() {
            // @expect 4.1.6 "The expression C.foo will fail at runtime"
            C.foo();
        }
        static function bar() as Void {
            // @expect 4.1.6 "The expression C.foo will fail at runtime"
            C.foo();
        }
        static function staticBySelf() as Void {
            self.foo();
        }
        static function staticNoQualifier() as Void {
            foo();
        }
        function nonStaticByName() as Void {
            // @expect 4.1.6 "The expression C.foo will fail at runtime"
            C.foo();
        }
        function nonStaticBySelf() as Void {
            self.foo();
        }
        function nonStaticNoQualifier() as Void {
            foo();
        }
        static function fv1() as Boolean {
            // @expect 4.1.6 "The expression C.v1 will fail at runtime"
            return C.v1;
        }
        static function fK1() as Number {
            // @expect 4.1.6 "The expression C.K1 will fail at runtime"
            return C.K1;
        }

        private static function foo() as Void {
            ok = true;
        }
    }
    class D extends C {
        static function baz() as Void {
            C.bar();
        }
    }

    (:test)
    function staticFromInitializeCrash4_1_6(logger as Logger) as Boolean {
        ok = false;
        var c = new C();
        return ok;
    }
    (:test)
    function staticFromStaticCrash4_1_6(logger as Logger) as Boolean {
        ok = false;
        C.bar();
        return ok;
    }
    (:test)
    function staticFromStaticBySelf(logger as Logger) as Boolean {
        ok = false;
        C.staticBySelf();
        return ok;
    }
    (:test)
    function staticFromStaticNoQualifier(logger as Logger) as Boolean {
        ok = false;
        C.staticNoQualifier();
        return ok;
    }
    (:test)
    function staticFromNonStaticByNameCrash4_1_6(logger as Logger) as Boolean {
        ok = false;
        (new C()).nonStaticByName();
        return ok;
    }
    (:test)
    function staticFromNonStaticBySelfCrash4_1_6(logger as Logger) as Boolean {
        ok = false;
        (new C()).nonStaticBySelf();
        return ok;
    }
    (:test)
    function staticFromNonStaticNoQualifierCrash4_1_6(
        logger as Logger
    ) as Boolean {
        ok = false;
        (new C()).nonStaticNoQualifier();
        return ok;
    }
    (:test)
    function staticFromDerivedCrash4_1_6(logger as Logger) as Boolean {
        ok = false;
        D.baz();
        return ok;
    }
    (:test)
    function staticVarCrash4_1_6(logger as Logger) as Boolean {
        return C.fv1() == false;
    }
    (:test)
    function staticConstCrash4_1_6U(logger as Logger) as Boolean {
        return C.fK1() == 42;
    }
}

module ShouldCallNew {
    var wasCalled as Boolean = false;
    class C {
        var x as Number = 0;
        function initialize(logger as Logger) {
            logger.debug("This should appear");
            wasCalled = true;
        }
        function foo() as Void {}
    }

    (:test)
    function callsNew(logger as Logger) as Boolean {
        wasCalled = false;
        var c = new C(logger);
        return wasCalled;
    }
    (:test)
    function callsNewAsStatementExpectedFail_4_1_6(
        logger as Logger
    ) as Boolean {
        wasCalled = false;
        new C(logger);
        return wasCalled;
    }
    (:test)
    function callsNewCallExpression(logger as Logger) as Boolean {
        wasCalled = false;
        (new C(logger)).foo();
        return wasCalled;
    }
    /*
    // 4.1.7 was fixed to make this fail at compile time.
    (:test)
    function callsNewMemberExpressionFailCompiler2(
        logger as Logger
    ) as Boolean {
        wasCalled = false;
        (new C(logger)).x;
        return wasCalled;
    }
    */
    (:test)
    function callsNewMemberExpression(logger as Logger) as Boolean {
        wasCalled = false;
        var x = (new C(logger)).x;
        return wasCalled;
    }
    // For now, these all cause syntax errors, so can't be tested
    /*
    (:test)
    function callsNewMemberPreUpdateExpression(logger as Logger) as Boolean {
        wasCalled = false;
        ++(new C(logger)).x;
        return wasCalled;
    }
    (:test)
    function callsNewMemberPostUpdateExpression(logger as Logger) as Boolean {
        wasCalled = false;
        (new C(logger)).x++;
        return wasCalled;
    }
    (:test)
    function callsNewMemberAssignmentExpression(logger as Logger) as Boolean {
        wasCalled = false;
        (new C(logger)).x += 42;
        return wasCalled;
    }
    */
}

module Compiler2 {
    module Nested {
        const L = 3;
        module M {
            class N {
                const K = 0;
                var V as Number = 0;
            }
        }
    }
    module Oddity {
        var V as Number = 42;
    }
    import Compiler2.Nested.M;
    (:inline)
    function localImports() as Number {
        return Oddity.V;
    }
    (:test)
    function testImportScope1(logger as Logger) as Boolean {
        ok = true;
        check(localImports(), 42, logger);
        return ok;
    }
    module Lang {
        module Oddity {
            var V as Number = 24;
        }
        const ENDIAN_LITTLE = 42;
        class Klass extends M.N {
            function foo() as Number {
                return self.Nested.L;
            }
            static function bar() as Number {
                return self.Lang.ENDIAN_LITTLE;
            }
            (:typecheck(false))
            static function baz() as Number {
                return self.Lang.Nested.L;
            }
        }
        module Mod {
        }
        module Inner {
            (:test,:typecheck(false))
            function testOutwardLookup(logger as Logger) as Boolean {
                // when lookup in a module fails, the runtime
                // searches outwards through the containing modules
                if (Toybox.Lang.Lang.ENDIAN_LITTLE != 0) {
                    return false;
                }
                // as above
                if (self.Mod.Mod.ENDIAN_LITTLE != 42) {
                    return false;
                }
                if ((new Klass()).foo() != 3) {
                    return false;
                }
                if (M.N.K != 0) {
                    return false;
                }
                if (Klass.K != 0) {
                    return false;
                }
                if (Klass.baz() != 3) {
                    return false;
                }
                return true;
            }
            (:test,:typecheck(false))
            function testImportCrash(logger as Logger) as Boolean {
                // @expect "N will only be found"
                return N.V == Lang.Lang.ENDIAN_LITTLE;
            }
            (:test,:typecheck(false))
            function testClassNonInstanceLookupCrash(
                logger as Logger
            ) as Boolean {
                // when class lookup fails, it doesn't search
                // the containing modules *unless* we're inside
                // a non-static method of the class.
                return self.Klass.ENDIAN_LITTLE == 42;
            }

            class Nested extends Klass {
                const K2 = K;
                const K3 = N.K + 1;
                (:typecheck(false))
                function test1(logger as Logger) as Boolean {
                    ok = true;
                    check(M.L, 3, logger);
                    // self.M doesn't resolve because we only check
                    //        imports for the first component.
                    check(K, 0, logger);
                    check(N.K, 0, logger);
                    check(Klass.Klass.K, 0, logger);
                    check(Klass.Klass.N.K, 0, logger);
                    check(K2, 0, logger);
                    check(K3, 1, logger);
                    check(self.Lang.ENDIAN_LITTLE, 42, logger);
                    check(self.Mod.ENDIAN_LITTLE, 42, logger);
                    return ok;
                }
                function test2(logger as Logger) as Boolean {
                    ok = true;
                    check(K, 0, logger);
                    check(N.K, 0, logger);
                    check(Klass.K, 0, logger);
                    return ok;
                }
                (:typecheck(false))
                static function test3(logger as Logger) as Boolean {
                    ok = true;
                    check(Klass.bar(), 42, logger);
                    check(Klass.Lang.ENDIAN_LITTLE, 42, logger);
                    check(Lang.ENDIAN_LITTLE, 0, logger);
                    check(self.Lang.ENDIAN_LITTLE, 42, logger);
                    return ok;
                }
            }
            (:test,:typecheck(false))
            function test(logger as Logger) as Boolean {
                return (new Nested()).test1(logger);
            }
            (:test)
            function test2(logger as Logger) as Boolean {
                return (new Nested()).test2(logger);
            }
            (:test)
            function test3(logger as Logger) as Boolean {
                return Nested.test3(logger);
            }
        }
    }
    import Compiler2.Lang.Oddity;
    (:test)
    function testImportScope2(logger as Logger) as Boolean {
        ok = true;
        check(localImports(), 42, logger);
        return ok;
    }
}

module StaticInheritance {
    class X {
        const K1 = 1;
        static function foo() as Number {
            return 42;
        }
        static function callFooFromX() as Number {
            return foo();
        }
        static function callSelfFooFromX() as Number {
            return self.foo();
        }
    }
    class Y extends X {
        function initialize() {
            X.initialize();
        }
        const K2 = K1 + 1;
        (:typecheck(false))
        static function getK1() as Number {
            // @expect "Undefined symbol K1"
            return K1;
        }
        (:typecheck(false))
        static function getK2() as Number {
            // @expect "Undefined symbol K2"
            return K2;
        }
        (:typecheck(false))
        static function callFooFromY() as Number {
            // @expect "Undefined symbol foo"
            return foo();
        }
        (:typecheck(false))
        static function callSelfFooFromY() as Number {
            // @expect "Undefined symbol self.foo"
            return self.foo();
        }
    }
    (:test)
    function test1(logger as Logger) as Boolean {
        logger.debug("K1=" + X.K1);
        logger.debug("K2=" + Y.K2);
        return X.K1 == 1 && (Y.K2 == 2 || Y.K2 == null);
    }
    (:test)
    function test2Crash(logger as Logger) as Boolean {
        logger.debug("K1=" + Y.getK1());
        return Y.getK1() == 1;
    }
    (:test)
    function test3Crash(logger as Logger) as Boolean {
        logger.debug("K2=" + Y.getK2());
        return Y.getK2() == 2;
    }
    (:test)
    function test4(logger as Logger) as Boolean {
        var y = new Y();
        return y.K1 == 1 && y.K2 == 2;
    }
    (:test)
    function testCallFooFromYCrash(logger as Logger) as Boolean {
        return Y.callFooFromY() == 42;
    }
    (:test)
    function testCallSelfFooFromYCrash(logger as Logger) as Boolean {
        return Y.callSelfFooFromY() == 42;
    }
    (:test)
    function testCallFooFromX(logger as Logger) as Boolean {
        return X.callFooFromX() == 42;
    }
    (:test)
    function testCallSelfFooFromX(logger as Logger) as Boolean {
        return X.callSelfFooFromX() == 42;
    }
}
