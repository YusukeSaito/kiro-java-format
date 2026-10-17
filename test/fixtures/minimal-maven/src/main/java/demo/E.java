package demo;

import java.util.List;
import org.apache.commons.lang3.StringUtils;
import java.util.ArrayList;
import java.util.Map;

public class E {
    private final List<Missing> items = new ArrayList<>();

  public void add(Missing item){
        if (item != null && StringUtils.isNotBlank(item.toString())) {
      items.add(item);
            }
    }
}
