package demo;

import java.util.List;
import org.apache.commons.lang3.StringUtils;
import java.util.Map;
import java.util.ArrayList;
import java.io.File;

public class A {
private final List<String> parts = new ArrayList<>();

      public void add(String part){
   if (StringUtils.isNotBlank(part)) {
        parts.add(StringUtils.trim(part));
  }
    }

public String joined( ) { return StringUtils.join(parts, ","); }
}
