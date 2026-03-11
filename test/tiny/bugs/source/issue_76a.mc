import Toybox.Lang;

module M1 {
    typedef Type as { :key1 as Number };
    module MSub {
        typedef Type as { :key2 as Number };
    }
    typedef MType as (Method(arg as MSub.Type) as Type);

    typedef ChildType as { :key1 as Number, :key2 as Number };

    function process(type as Type or MType) as Void {}

    function cast1(type as ChildType) as Type {
        return type as Type;
    }
    function cast2(type as ChildType) as MSub.Type {
        return type as MSub.Type;
    }
    function cast3(type as (Method(arg as ChildType) as Type)) as MType {
        return type as (Method(arg as MSub.Type) as Type);
    }

    function create() as ChildType {
        return { :key1 => 0, :key2 => 0 };
    }
    function createM() as MType {
        return (
            new Lang.Method(M1, :cast1) as (Method(arg as ChildType) as Type)
        );
    }
}
