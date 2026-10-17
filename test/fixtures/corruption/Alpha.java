import java.util.Map;
import java.util.List;
import java.util.Set;
import java.util.HashMap;
import java.io.File;
import java.util.ArrayList;

public class Alpha {
private Map<String,Integer> counts = new HashMap<>();
    private List<String>   names = new ArrayList<>();

      public void add(String name){
   names.add(name);
        counts.put(name, counts.getOrDefault(name,0)+1);
  }

public int size( ) { return names.size(); }

    public int countOf(String name) {
  return counts.getOrDefault(name, 0);
      }
}
