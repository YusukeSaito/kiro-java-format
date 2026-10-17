package demo;

import java.util.Locale;
import java.util.HashMap;
import org.apache.commons.lang3.StringUtils;
import java.util.Map;
import java.util.UUID;

public class C {
      private final Map<String, Integer> lengths = new HashMap<>();

  public int measure(String text) {
            int n = StringUtils.length(StringUtils.deleteWhitespace(text));
    lengths.put(text.toLowerCase(Locale.ROOT), n);
                return n;
    }
}
