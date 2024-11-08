class BaseClass {
    function doThings() as Void {}
}
class ParentClass extends BaseClass {
    function doThings() as Void {}
}
class ChildClass1 extends ParentClass {
    function doThings() as Void {
        ParentClass.doThings();
    }
}
class ChildClass2 extends ParentClass {
    function doThings() as Void {
        ParentClass.doThings();
    }
}

class Test {
    function test(object as BaseClass) as Void {
        object.doThings();
        object.doThings();
        object.doThings();
        object.doThings();
        object.doThings();
        object.doThings();
        object.doThings();
        object.doThings();
        object.doThings();
        object.doThings();
        object.doThings();
        object.doThings();
        object.doThings();
        object.doThings();
        object.doThings();
        object.doThings();
    }
}
