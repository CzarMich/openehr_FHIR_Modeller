using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Modeller.Core;
namespace Modeller.Database;

// Metadata only. No clinical rows, example values, patient identifiers or inferred clinical semantics.
public sealed record SourceColumn(int Id,string Name,string Type,bool Nullable,bool Computed,int KeyOrdinal);
public sealed record SourceTable(int Id,string Schema,string Name,SourceColumn[] Columns);
public sealed record SourceKey(int Id,int FromTable,int[] FromColumns,int ToTable,int[] ToColumns,bool Disabled,bool Untrusted);
public sealed record SchemaCatalogue(SourceTable[] Tables,SourceKey[] Keys)
{
    [System.Text.Json.Serialization.JsonIgnore]
    public string Fingerprint=>Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new{Tables,Keys}))));
    public SourceTable Table(int id)=>Tables.SingleOrDefault(t=>t.Id==id)??throw new ProcessingException("SOURCE_TABLE_UNKNOWN");
    public SourceColumn Column(int table,int column)=>Table(table).Columns.SingleOrDefault(c=>c.Id==column)??throw new ProcessingException("SOURCE_COLUMN_UNKNOWN");
    public SourceTable[] Search(string query,int after=0,int limit=25){
        if(query.Length>128||after<0||limit is <1 or >50)throw new ProcessingException("SOURCE_DISCOVERY_LIMIT");
        return Tables.Where(t=>t.Id>after&&(query.Length==0||t.Schema.Contains(query,StringComparison.OrdinalIgnoreCase)||t.Name.Contains(query,StringComparison.OrdinalIgnoreCase)||t.Columns.Any(c=>c.Name.Contains(query,StringComparison.OrdinalIgnoreCase)))).OrderBy(t=>t.Id).Take(limit).ToArray();
    }
}
public sealed record SourceProjection(int Table,int Column,string Field,string Representation="native");
public sealed record SourceJoin(int Key,string Kind);
public sealed record SourceFilter(int Table,int Column,string Operator,JsonElement? Value);
public sealed record SourcePlan(string SchemaFingerprint,int Root,SourceProjection[] Fields,SourceJoin[] Joins,SourceFilter[] Filters,int Limit);
public sealed record BoundValue(string Name,string SqlType,object Value);
public sealed record CompiledSourcePlan(string Sql,BoundValue[] Parameters,string SchemaFingerprint);

public static class SourcePlanCompiler
{
    private static string Q(string name)=>"["+name.Replace("]","]]",StringComparison.Ordinal)+"]";
    private static string Qualified(SourceTable t)=>Q(t.Schema)+"."+Q(t.Name);
    public static CompiledSourcePlan Compile(SchemaCatalogue schema,SourcePlan plan,string dialect="sqlserver"){
        string Q(string name)=>dialect switch { "sqlserver"=>"["+name.Replace("]","]]",StringComparison.Ordinal)+"]", "mysql" or "mariadb"=>"`"+name.Replace("`","``",StringComparison.Ordinal)+"`", "postgresql" or "oracle" or "sap-hana"=>"\""+name.Replace("\"","\"\"",StringComparison.Ordinal)+"\"", _=>throw new ProcessingException("SOURCE_DIALECT_UNKNOWN") };
        string Qualified(SourceTable table)=>Q(table.Schema)+"."+Q(table.Name);
        string Parameter(int index)=>dialect=="oracle"?":p"+index:dialect=="sap-hana"?"?":"@p"+index;
        if(plan.SchemaFingerprint!=schema.Fingerprint)throw new ProcessingException("SOURCE_SCHEMA_CHANGED");
        if(plan.Limit is <1 or >10000||plan.Fields.Length is <1 or >128||plan.Joins.Length>8||plan.Filters.Length>32)throw new ProcessingException("SOURCE_PLAN_LIMIT");
        var root=schema.Table(plan.Root);var aliases=new Dictionary<int,string>{{root.Id,"t0"}};var joins=new List<string>();
        foreach(var join in plan.Joins){
            if(join.Kind is not("inner" or "left"))throw new ProcessingException("SOURCE_JOIN_UNSUPPORTED");
            var key=schema.Keys.SingleOrDefault(k=>k.Id==join.Key)??throw new ProcessingException("SOURCE_KEY_UNKNOWN");
            if(key.Disabled||key.Untrusted||key.FromColumns.Length==0||key.FromColumns.Length!=key.ToColumns.Length)throw new ProcessingException("SOURCE_KEY_UNQUALIFIED");
            var fromKnown=aliases.ContainsKey(key.FromTable);var toKnown=aliases.ContainsKey(key.ToTable);
            if(fromKnown==toKnown)throw new ProcessingException("SOURCE_JOIN_DISCONNECTED");
            var next=fromKnown?key.ToTable:key.FromTable;aliases[next]="t"+aliases.Count;var table=schema.Table(next);
            var predicates=key.FromColumns.Zip(key.ToColumns,(a,b)=>Reference(key.FromTable,a)+" = "+Reference(key.ToTable,b));
            joins.Add((join.Kind=="left"?" LEFT JOIN ":" INNER JOIN ")+Qualified(table)+" "+aliases[next]+" ON "+string.Join(" AND ",predicates));
        }
        string Reference(int table,int column){var c=schema.Column(table,column);if(c.Computed)throw new ProcessingException("SOURCE_COMPUTED_COLUMN_DENIED");if(!aliases.TryGetValue(table,out var a))throw new ProcessingException("SOURCE_TABLE_NOT_JOINED");return a+"."+Q(c.Name);}
        var fields=new HashSet<string>(StringComparer.OrdinalIgnoreCase);var select=plan.Fields.Select(p=>{if(p.Representation is not("native" or "string"))throw new ProcessingException("SOURCE_REPRESENTATION_INVALID");if(!System.Text.RegularExpressions.Regex.IsMatch(p.Field,"^[A-Za-z][A-Za-z0-9_]{0,63}$")||!fields.Add(p.Field))throw new ProcessingException("SOURCE_FIELD_INVALID");return Reference(p.Table,p.Column)+" AS "+Q(p.Field);}).ToArray();
        var parameters=new List<BoundValue>();var filters=new List<string>();
        foreach(var filter in plan.Filters){var reference=Reference(filter.Table,filter.Column);if(filter.Operator is "is-null" or "not-null"){if(filter.Value is not null&&filter.Value.Value.ValueKind!=JsonValueKind.Null)throw new ProcessingException("SOURCE_FILTER_INVALID");filters.Add(reference+(filter.Operator=="is-null"?" IS NULL":" IS NOT NULL"));continue;}
            var op=filter.Operator switch{"eq"=>"=","ne"=>"<>","gt"=>">","ge"=>">=","lt"=>"<","le"=>"<=",_=>throw new ProcessingException("SOURCE_FILTER_INVALID")};
            var column=schema.Column(filter.Table,filter.Column);var value=Bind(column.Type,filter.Value);var parameter=Parameter(parameters.Count);parameters.Add(new(parameter,column.Type,value));filters.Add(reference+" "+op+" "+parameter);
        }
        var keyColumns=root.Columns.Where(c=>c.KeyOrdinal>0).OrderBy(c=>c.KeyOrdinal).ToArray();if(keyColumns.Length==0)throw new ProcessingException("SOURCE_STABLE_KEY_REQUIRED");
        var order=string.Join(", ",keyColumns.Select(c=>Reference(root.Id,c.Id)));
        var rowParameter=dialect=="oracle"?":rowLimit":dialect=="sap-hana"?"?":"@rowLimit";
        var sql="SELECT "+(dialect=="sqlserver"?"TOP (@rowLimit) ":"")+string.Join(", ",select)+" FROM "+Qualified(root)+" t0"+string.Concat(joins)+(filters.Count==0?"":" WHERE "+string.Join(" AND ",filters))+" ORDER BY "+order+(dialect=="sqlserver"?"":dialect=="oracle"?" FETCH FIRST "+rowParameter+" ROWS ONLY":" LIMIT "+rowParameter)+";";
        parameters.Add(new(rowParameter,"int",plan.Limit));return new(sql,parameters.ToArray(),schema.Fingerprint);
    }
    private static object Bind(string type,JsonElement? nullable){
        if(nullable is null||nullable.Value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)throw new ProcessingException("SOURCE_FILTER_INVALID");var v=nullable.Value;type=type.ToLowerInvariant();
        try{return type switch{
            "nvarchar" or "varchar" or "nchar" or "char" or "bpchar" or "text" or "character varying" or "character" or "varchar2" or "nvarchar2" or "alphanum"=>v.ValueKind==JsonValueKind.String&&v.GetString()!.Length<=4000?v.GetString()!:throw new ProcessingException("SOURCE_FILTER_INVALID"),
            "bigint" or "int8"=>v.ValueKind==JsonValueKind.String?long.Parse(v.GetString()!,System.Globalization.NumberStyles.AllowLeadingSign,System.Globalization.CultureInfo.InvariantCulture):v.GetInt64(),"int" or "integer" or "int4"=>v.ValueKind==JsonValueKind.String?int.Parse(v.GetString()!,System.Globalization.NumberStyles.AllowLeadingSign,System.Globalization.CultureInfo.InvariantCulture):v.GetInt32(),"smallint" or "int2"=>v.ValueKind==JsonValueKind.String?short.Parse(v.GetString()!,System.Globalization.NumberStyles.AllowLeadingSign,System.Globalization.CultureInfo.InvariantCulture):v.GetInt16(),"tinyint"=>v.ValueKind==JsonValueKind.String?byte.Parse(v.GetString()!,System.Globalization.NumberStyles.None,System.Globalization.CultureInfo.InvariantCulture):v.GetByte(),"bit" or "boolean" or "bool"=>v.GetBoolean(),
            "decimal" or "numeric" or "number" or "money" or "smallmoney"=>v.ValueKind==JsonValueKind.String?decimal.Parse(v.GetString()!,System.Globalization.NumberStyles.AllowLeadingSign|System.Globalization.NumberStyles.AllowDecimalPoint,System.Globalization.CultureInfo.InvariantCulture):v.GetDecimal(),
            "uniqueidentifier" or "uuid"=>Guid.ParseExact(v.GetString()!,"D"),
            "date"=>DateOnly.ParseExact(v.GetString()!,"yyyy-MM-dd",System.Globalization.CultureInfo.InvariantCulture).ToDateTime(TimeOnly.MinValue),
            "datetimeoffset"=>DateTimeOffset.ParseExact(v.GetString()!,"O",System.Globalization.CultureInfo.InvariantCulture),
            _=>throw new ProcessingException("SOURCE_FILTER_TYPE_UNSUPPORTED")};
        }catch(Exception e)when(e is FormatException or InvalidOperationException or OverflowException or ArgumentException){throw new ProcessingException("SOURCE_FILTER_INVALID");}
    }
}
