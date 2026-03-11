module M2 {
    (:keep)
    function f() as Void {
        M1.process(M1.cast1(M1.create()));
        M1.process(M1.cast2(M1.create()));
        M1.process(M1.cast3(M1.createM()));
    }
}
