using System.Text.Json.Nodes;
using Modeller.Application;
static class DocumentProfileTests
{
    public static async Task Run(Action<bool,string> check){
        using var engine=new StandardsGateway();async Task<JsonObject> Validate(string content,string format)=>await ModelChecks.Validate(new JsonObject{["content"]=content,["format"]=format},engine,CancellationToken.None);
        bool Has(JsonObject report,string code)=>(report["findings"] as JsonArray??[]).OfType<JsonObject>().Any(item=>item["code"]?.GetValue<string>()==code);
        foreach(var(format,text)in new[]{("flat","{\"observations/temperature|magnitude\":37.5}"),("structured","{\"ctx\":{\"setting\":[{\"|code\":\"238\"}]},\"observations\":{\"temperature\":[{\"|magnitude\":37.5}]}}")}){
            var report=await Validate(text,format);check(report["parse_valid"]?.GetValue<bool>()==true&&report["structurally_valid"]?.GetValue<bool>()==true&&report["valid"] is null&&report["release_eligible"]?.GetValue<bool>()==false,"simplified shape is not semantic conformance: "+format);}
        check(Has(await Validate("{}","flat"),"SIMPLIFIED_ROOT"),"empty simplified document is rejected");
        check(Has(await Validate("{\"/invalid\":2}","flat"),"FLAT_FIELD_IDENTIFIER"),"FLAT identifier profile enforced");
        check(Has(await Validate("{\"root/value\":{\"x\":1}}","flat"),"FLAT_VALUE_SHAPE"),"FLAT nested objects require raw suffix");
        check(Has(await Validate("{\"root/value|raw\":{\"_type\":\"DV_TEXT\",\"value\":\"synthetic\"}}","flat"),"RAW_TYPE_REQUIRED")==false,"explicit raw RM object shape accepted without conformance claim");
        check(Has(await Validate("{\"root/value|raw\":{\"value\":\"synthetic\"}}","flat"),"RAW_TYPE_REQUIRED"),"raw object needs explicit type");
        check(Has(await Validate("{\"root\":{\"node\":1}}","structured"),"STRUCTURED_NODE_ARRAY"),"STRUCTURED nodes require occurrence arrays");
        check(Has(await Validate("{\"root\":{\"node\":[[1]]}}","structured"),"STRUCTURED_NESTED_ARRAY"),"nested occurrence arrays rejected");
        var ambiguous=await Validate("{\"x\":1,\"x\":2}","flat");check(ambiguous["parse_valid"]?.GetValue<bool>()==false&&ambiguous["valid"]?.GetValue<bool>()==false,"duplicate fields cannot produce a valid shape");
        check(Has(await Validate("{\"root/value\":1e999}","flat"),"JSON_NUMBER_RANGE"),"nonfinite numeric conversion rejected");
        const string oet="<template xmlns=\"openEHR/v1/Template\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"><id>Synthetic</id><name>Synthetic</name><definition xsi:type=\"COMPOSITION\" archetype_id=\"openEHR-EHR-COMPOSITION.synthetic.v1\"><Content xsi:type=\"OBSERVATION\" archetype_id=\"openEHR-EHR-OBSERVATION.synthetic.v1\"/></definition></template>";
        var valid=await Validate(oet,"oet");check(valid["structurally_valid"]?.GetValue<bool>()==true&&valid["valid"] is null,"typed OET profile remains partial");
        check(Has(await Validate(oet.Replace("xsi:type=\"COMPOSITION\"","xsi:type=\"SECTION\"",StringComparison.Ordinal),"oet"),"OET_ROOT_TYPE_INVALID"),"OET root type checked");
        check(Has(await Validate(oet.Replace("<Content ","<Item ",StringComparison.Ordinal),"oet"),"OET_PLACEMENT_KIND_INVALID"),"OET parent placement relationship checked");
        check(Has(await Validate(oet.Replace("<Content ","<Content min=\"999999999999999999999999999999\" max=\"2\" ",StringComparison.Ordinal),"oet"),"REVERSED_OCCURRENCES"),"occurrence comparison cannot overflow");
        const string opt="<template xmlns=\"http://schemas.openehr.org/v1\"><template_id><value>Synthetic</value></template_id><language><code_string>en</code_string></language><concept>Synthetic</concept><definition><occurrences><lower>2</lower><upper>1</upper></occurrences></definition></template>";
        check(Has(await Validate(opt,"opt"),"REVERSED_INTERVAL"),"OPT interval order checked");
        check(Has(await Validate(opt.Replace("<upper>1</upper>","<upper>3</upper><upper_unbounded>true</upper_unbounded>",StringComparison.Ordinal),"opt"),"INVALID_INTERVAL_BOUND"),"OPT explicit upper bound and unbounded flag cannot conflict");
        var adl=await Validate("archetype (adl_version=2.0.6)\nopenEHR-EHR-OBSERVATION.synthetic.v1\n","adl");check(adl["parse_valid"] is null&&adl["valid"] is null&&!Has(adl,"ADL_DECLARATION_PREFLIGHT"),"ADL header is not a grammar parse");
        check(Has(await Validate("-- archetype openEHR-EHR-OBSERVATION.synthetic.v1\ninvalid","adl"),"ADL_DECLARATION_PREFLIGHT"),"ADL declaration cannot be supplied by a comment");
        var generic=await Validate("<a/>","xml");check(generic["valid"]?.GetValue<bool>()==true&&generic["scope"]?.GetValue<string>()=="xml_well_formedness","generic XML validates only its requested scope");
        var reorder=ModelChecks.Diff("<root><node id=\"x\" name=\"a\"/></root>","<root><node name=\"a\" id=\"x\"/></root>");check(reorder["semantic_differences"]!.AsArray().Count==0,"XML attribute order does not create model changes");
        var changed=ModelChecks.Diff("<root><node min=\"0\"/></root>","<root><node min=\"1\"/></root>");check(changed["semantic_differences"]?[0]?["dimension"]?.GetValue<string>()=="occurrences_and_cardinalities","explicit cardinality difference classified");
        var move=ModelChecks.Diff("<root><left><node node_id=\"at0001\"/></left><right/></root>","<root><left/><right><node node_id=\"at0001\"/></right></root>");check(move["semantic_differences"]!.AsArray().OfType<JsonObject>().Any(item=>item["change"]?.GetValue<string>()=="moved"),"unique explicit node move detected");
        var ambiguousMove=ModelChecks.Diff("<root><left><node node_id=\"at0001\"/><node node_id=\"at0001\"/></left><right/></root>","<root><left/><right><node node_id=\"at0001\"/><node node_id=\"at0001\"/></right></root>");check(!ambiguousMove["semantic_differences"]!.AsArray().OfType<JsonObject>().Any(item=>item["change"]?.GetValue<string>()=="moved"),"duplicate node identity never implies a unique move");
    }
}
