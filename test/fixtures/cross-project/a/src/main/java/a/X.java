package a;

import java.util.List;
import b.OnlyInB;
import java.util.ArrayList;
import java.util.Map;

public class X {
  private final List<OnlyInB> items = new ArrayList<>();

      public void add(OnlyInB item){
   items.add(item);
        }

public int size() { return items.size(); }
}
