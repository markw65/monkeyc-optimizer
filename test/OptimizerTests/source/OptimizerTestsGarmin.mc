import Toybox.Lang;
import Toybox.Test;

const NESTINGB1 = 1001;
const NESTINGB2 = 1002;
const NESTINGB3 = 1003;
const NESTINGB4 = 1004;

module nesting {
    const NESTINGC1 = 2001;
    const NESTINGC2 = 2002;
    const NESTINGC3 = 2003;
    const NESTINGC4 = 2004;

    module MB {
        const NESTINGA1 = 1;
        const NESTINGB1 = 1;
        const NESTINGC1 = 1;
        class Base {
            const NESTINGA2 = 2;
            const NESTINGB2 = 2;
            const NESTINGC2 = 2;
        }
    }

    module MC {
        const NESTINGA3 = 3;
        const NESTINGB3 = 3;
        const NESTINGC3 = 3;
        class X extends MB.Base {
            function initialize() {
                Base.initialize();
            }
            const NESTINGA4 = 4;
            const NESTINGB4 = 4;
            const NESTINGC4 = 4;

            function getNESTINGA1() as Number {
                return NESTINGA1;
            }
            function getNESTINGA2() as Number {
                return NESTINGA2;
            }
            function getNESTINGA3() as Number {
                return NESTINGA3;
            }
            function getNESTINGA4() as Number {
                return NESTINGA4;
            }

            function getNESTINGB1() as Number {
                return NESTINGB1;
            }
            function getNESTINGB2() as Number {
                return NESTINGB2;
            }
            function getNESTINGB3() as Number {
                return NESTINGB3;
            }
            function getNESTINGB4() as Number {
                return NESTINGB4;
            }

            function getNESTINGC1() as Number {
                return NESTINGC1;
            }
            function getNESTINGC2() as Number {
                return NESTINGC2;
            }
            function getNESTINGC3() as Number {
                return NESTINGC3;
            }
            function getNESTINGC4() as Number {
                return NESTINGC4;
            }

            class Y {
                (:typecheck(false))
                function getNESTINGA1() as Number {
                    // @expect "Undefined symbol"
                    return NESTINGA1;
                }
                (:typecheck(false))
                function getNESTINGA2() as Number {
                    // @expect "Undefined symbol"
                    return NESTINGA2;
                }
                (:typecheck(false))
                function getNESTINGA3() as Number {
                    // @expect "Undefined symbol"
                    return NESTINGA3;
                }
                (:typecheck(false))
                function getNESTINGA4() as Number {
                    // @expect "Undefined symbol"
                    return NESTINGA4;
                }

                function getNESTINGB1() as Number {
                    return NESTINGB1;
                }
                function getNESTINGB2() as Number {
                    return NESTINGB2;
                }
                function getNESTINGB3() as Number {
                    return NESTINGB3;
                }
                function getNESTINGB4() as Number {
                    return NESTINGB4;
                }

                (:typecheck(false))
                function getNESTINGC1() as Number {
                    // @expect "Undefined symbol"
                    return NESTINGC1;
                }
                (:typecheck(false))
                function getNESTINGC2() as Number {
                    // @expect "Undefined symbol"
                    return NESTINGC2;
                }
                (:typecheck(false))
                function getNESTINGC3() as Number {
                    // @expect "Undefined symbol"
                    return NESTINGC3;
                }
                (:typecheck(false))
                function getNESTINGC4() as Number {
                    // @expect "Undefined symbol"
                    return NESTINGC4;
                }
            }
        }
    }

    var ok as Boolean = false;
    function check(
        message as String,
        value as Number,
        expected as Number,
        logger as Logger
    ) as Void {
        var res;
        if (value != expected) {
            res = "Failed: " + value.toString() + " != " + expected.toString();
            ok = false;
        } else {
            res = "Passed!";
        }
        logger.debug("Checking " + message + " - " + res);
    }

    (:test)
    function testClassLookup(logger as Logger) as Boolean {
        ok = true;
        var x = new nesting.MC.X();
        check("ClassNESTINGA1", x.getNESTINGA1(), 1, logger);
        check("ClassNESTINGA2", x.getNESTINGA2(), 2, logger);
        check("ClassNESTINGA3", x.getNESTINGA3(), 3, logger);
        check("ClassNESTINGA4", x.getNESTINGA4(), 4, logger);

        check("ClassNESTINGB1", x.getNESTINGB1(), 1001, logger);
        check("ClassNESTINGB2", x.getNESTINGB2(), 2, logger);
        check("ClassNESTINGB3", x.getNESTINGB3(), 3, logger);
        check("ClassNESTINGB4", x.getNESTINGB4(), 4, logger);

        check("ClassNESTINGC1", x.getNESTINGC1(), 2001, logger);
        check("ClassNESTINGC2", x.getNESTINGC2(), 2, logger);
        check("ClassNESTINGC3", x.getNESTINGC3(), 3, logger);
        check("ClassNESTINGC4", x.getNESTINGC4(), 4, logger);
        return ok;
    }

    (:test)
    function testNestedLookup(logger as Logger) as Boolean {
        ok = true;
        var x = new nesting.MC.X.Y();

        check("NestedNESTINGB1", x.getNESTINGB1(), 1001, logger);
        check("NestedNESTINGB2", x.getNESTINGB2(), 1002, logger);
        /*
         * Hack. "4.1.4 Compiler2Beta 2" includes outer modules
         * when doing lookups in nested classes. For now, accept
         * both values.
         */
        var v = x.getNESTINGB3();
        check("NestedNESTINGB3", v == 3 ? 1003 : v, 1003, logger);
        check("NestedNESTINGB4", x.getNESTINGB4(), 1004, logger);
        return ok;
    }

    /* these are expected to crash. They fail if they don't */
    (:test)
    function nestedLookupNESTINGA1Crash(logger as Logger) as Boolean {
        var x = new nesting.MC.X.Y();
        logger.debug(x.getNESTINGA1());
        return false;
    }
    (:test)
    function nestedLookupNESTINGA2Crash(logger as Logger) as Boolean {
        var x = new nesting.MC.X.Y();
        logger.debug(x.getNESTINGA2());
        return false;
    }
    (:test)
    function nestedLookupNESTINGA3Crash(logger as Logger) as Boolean {
        var x = new nesting.MC.X.Y();
        logger.debug(x.getNESTINGA3());
        // In compiler2Beta 2, outer modules, and the global scope
        // are searched.
        return true;
    }
    (:test)
    function nestedLookupNESTINGA4Crash(logger as Logger) as Boolean {
        var x = new nesting.MC.X.Y();
        logger.debug(x.getNESTINGA4());
        return false;
    }
    (:test)
    function nestedLookupNESTINGC1Crash(logger as Logger) as Boolean {
        var x = new nesting.MC.X.Y();
        logger.debug(x.getNESTINGC1());
        // In compiler2Beta 2, outer modules, and the global scope
        // are searched.
        return true;
    }
    (:test)
    function nestedLookupNESTINGC2Crash(logger as Logger) as Boolean {
        var x = new nesting.MC.X.Y();
        logger.debug(x.getNESTINGC2());
        // In compiler2Beta 2, outer modules, and the global scope
        // are searched.
        return true;
    }
    (:test)
    function nestedLookupNESTINGC3Crash(logger as Logger) as Boolean {
        var x = new nesting.MC.X.Y();
        logger.debug(x.getNESTINGC3());
        // In compiler2Beta 2, outer modules, and the global scope
        // are searched.
        return true;
    }
    (:test)
    function nestedLookupNESTINGC4Crash(logger as Logger) as Boolean {
        var x = new nesting.MC.X.Y();
        logger.debug(x.getNESTINGC4());
        // In compiler2Beta 2, outer modules, and the global scope
        // are searched.
        return true;
    }
}

module LocalResolution {
    module AX {
        module BX {
            const K = 1;
        }
    }
    import LocalResolution.AX.BX;
    module CX {
        module BX {
            const K = 1001;
        }
        class X {
            const K = 2001;
            const Y = 2;
        }
        //(:typecheck(false))
        function foo() as Number {
            var BX = new X();
            return BX.K;
        }
    }
    (:test)
    function test(logger as Logger) as Boolean {
        var k = CX.foo();
        if (k != 2001) {
            logger.debug("Oops - found the wrong k: " + k.toString());
            return false;
        }
        return true;
    }
}

module ImportWeirdness {
    module Strange {
        import ImportWeirdness.ImportedOutOfScope;
    }
    module NotImported {
        const K = 0;
    }
    module ImportedInScope {
        const K = 1;
    }
    module ImportedOutOfScope {
        const K = 2;
    }
    module Nest {
        import ImportWeirdness.ImportedInScope;
        module NotImported {
            const K = 3;
        }
        module ImportedInScope {
            const K = 4;
        }
        module ImportedOutOfScope {
            const K = 5;
        }
        (:test)
        function test(logger as Logger) as Boolean {
            var ok = true;
            if (NotImported.K != 3) {
                logger.debug(
                    "NotImported.K was " + NotImported.K.toString() + " not 3"
                );
                ok = false;
            }
            if (ImportedInScope.K != 1) {
                logger.debug(
                    "ImportedInScope.K was " +
                        ImportedInScope.K.toString() +
                        " not 1"
                );
                ok = false;
            }
            if (ImportedOutOfScope.K != 5) {
                logger.debug(
                    "ImportedOutOfScope.K was " +
                        ImportedOutOfScope.K.toString() +
                        " not 5"
                );
                ok = false;
            }
            return ok;
        }
    }
}

function arrayNumber(x as Array<Number>) as Number {
    return x.size();
}

function arrayNumberOrArray(x as Array<Number or Array>) as Number {
    return x.size();
}

typedef ArrayOrNumber as Array or Number;

(:test)
function testSizedArrayTypes(logger as Logger) as Boolean {
    return (
        arrayNumber(new Number [5]) == 5 &&
        arrayNumber(new Array<Number>[5]) == 5 &&
        arrayNumberOrArray(new ArrayOrNumber [5]) == 5
    );
}
